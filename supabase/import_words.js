import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const AI_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Filter pre citlivé výrazy, ktoré majú viacero významov v kontexte hry
const SENSITIVE_TERMS = [
  "Deck", "Driver", "Live Table", "Chest", "E-Power", "D-Power", "Checkpoint", "Gate"
];

// Pomocná funkcia: Detekcia "False Alarm" (AI sa len chváli, že dodržala pravidlá)
const isFalseAlarm = (note: string | null): boolean => {
    if (!note) return true;
    
    const lowerNote = note.toLowerCase();
    
    const justificationWords = [
        "consistent", "adhere", "reflect", "followed", "according to", "standard translation", "glossary", "referring to"
    ];

    const warningWords = [
        "untranslated", "kept in english", "ambiguous", "conflict", "unsure", "difficult", "literal", "imply", "implies", "anatomy"
    ];

    const isJustification = justificationWords.some(w => lowerNote.includes(w));
    const isWarning = warningWords.some(w => lowerNote.includes(w));

    if (isJustification && !isWarning) {
        return true;
    }

    return false;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { rows } = await req.json(); 
    
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      throw new Error("Invalid input: 'rows' array is required.");
    }

    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    // Načítanie PROMPTU z databázy
    const { data: promptData, error: promptError } = await supabase
        .from("prompts")
        .select("prompt") 
        .eq("name", "Import words")
        .single();

    if (promptError || !promptData) {
        throw new Error(`Failed to fetch prompt 'Import words': ${promptError?.message || "Not found"}`);
    }

    const GAME_BIBLE_PROMPT = promptData.content;

    // ---------------------------------------------------------

    const cleanDataMap = new Map();
    rows.forEach(row => {
        if (row.translation_key && row.source_text) {
            const key = String(row.translation_key).trim();
            cleanDataMap.set(key, {
                source: row.source_text,
                category: row.category || null
            });
        }
    });

    const enPayload = Array.from(cleanDataMap.entries()).map(([key, data]) => ({
        translation_key: key,
        language_code: 'en',
        translated_text: data.source,
        category: data.category,
        last_updated: new Date().toISOString()
    }));

    const { error: enError } = await supabase
        .from("translations")
        .upsert(enPayload, { onConflict: "translation_key,language_code" });

    if (enError) {
        throw new Error(`Failed to UPSERT English records: ${enError.message}`);
    }

    const { data: languages, error: langError } = await supabase
      .from("languages")
      .select("code")
      .neq("code", "en");

    if (langError) throw langError;

    const inputForAI = {};
    for (const [key, data] of cleanDataMap.entries()) {
        inputForAI[key] = data.source;
    }

    const report: any = { processed: [], warnings: [], review_items: [] };

    for (const lang of languages) {
      const targetLang = lang.code;
      
      try {
        const completion = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: AI_MODEL, 
            messages: [
              { role: "system", content: GAME_BIBLE_PROMPT }, // použije sa načítaný text z DB
              { 
                role: "user", 
                content: `TASK: Translate JSON from English to Language Code: "${targetLang}".\nJSON INPUT:\n${JSON.stringify(inputForAI)}` 
              }
            ],
            response_format: { type: "json_object" }
          }),
        });

        if (!completion.ok) {
            report.warnings.push({ lang: targetLang, msg: "AI Failed" });
            continue;
        }

        const aiResponse = await completion.json();
        let content;
        try {
            content = JSON.parse(aiResponse.choices[0].message.content);
        } catch (e) {
            content = { translations: {} };
        }
        
        const translations = content.translations || {};
        const notes = content.notes || {};

        const payloadMap = new Map();

        Object.keys(translations).forEach(key => {
            const cleanKey = key.trim();
            if (cleanDataMap.has(cleanKey)) {
                payloadMap.set(cleanKey, {
                    translation_key: cleanKey,
                    language_code: targetLang,
                    translated_text: translations[key],
                    category: cleanDataMap.get(cleanKey).category,
                    last_updated: new Date().toISOString()
                });
            }
        });

        const transPayload = Array.from(payloadMap.values());

        if (transPayload.length > 0) {
            const { error: upsertError } = await supabase
                .from("translations")
                .upsert(transPayload, { onConflict: "translation_key,language_code" });
            
            if (upsertError) {
                report.warnings.push({ lang: targetLang, msg: upsertError.message });
            } else {
                report.processed.push(targetLang);
            }
        }

        transPayload.forEach(item => {
            const original = cleanDataMap.get(item.translation_key).source;
            const rawNote = notes[item.translation_key];
            
            let finalNote = "";
            
            if (rawNote) {
                if (typeof rawNote === 'string') {
                    finalNote = rawNote;
                } else if (typeof rawNote === 'object') {
                    finalNote = Object.values(rawNote).join(". ");
                }
            }

            const isIdentical = item.translated_text === original && isNaN(Number(original)) && String(original).length > 1;
            const containsSensitiveTerm = SENSITIVE_TERMS.some(term => original.includes(term));
            
            const isFalsePos = isFalseAlarm(finalNote);

            let shouldReport = false;
            let reportType = "";

            if (containsSensitiveTerm && isIdentical) {
                shouldReport = true;
                reportType = "Untranslated Critical Term";
            } else if (finalNote && !isFalsePos) {
                shouldReport = true;
                reportType = "AI Warning";
            }

            if (shouldReport) {
                report.review_items.push({
                    lang: targetLang,
                    key: item.translation_key,
                    en: original,
                    target: item.translated_text,
                    reason: finalNote || "Term kept in English or Identical to Source.",
                    type: reportType
                });
            }
        });

      } catch (err) {
        report.warnings.push({ lang: targetLang, msg: err.message });
      }

      if (languages.indexOf(lang) < languages.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    return new Response(JSON.stringify({ success: true, report }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});