import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const AI_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

const BATCH_SIZE = 60; 
const RATE_LIMIT_DELAY_MS = 25000; 
const STANDARD_DELAY_MS = 2000;    

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { target_language } = await req.json();

    if (!target_language) throw new Error("Missing 'target_language' in request body.");

    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    // 1. Získanie názvu jazyka
    const { data: langData, error: langError } = await supabase
        .from("languages")
        .select("name")
        .eq("code", target_language)
        .single();

    if (langError || !langData) throw new Error(`Language code '${target_language}' not found.`);

    const fullLanguageName = langData.name;
    console.log(`Translating to: ${fullLanguageName} (${target_language})`);

    // 2. Získanie PROMPTU z databázy
    const { data: promptData, error: promptError } = await supabase
        .from("prompts")
        .select("prompt") 
        .eq("name", "New Language Prompt")
        .maybeSingle(); 

    if (promptError) {
        throw new Error(`Database error fetching prompt: ${promptError.message}`);
    }

    if (!promptData) {
        throw new Error("Prompt with name 'New Language Prompt' not found in table 'prompts'.");
    }

    const GAME_BIBLE_PROMPT = promptData.prompt; 

    if (!GAME_BIBLE_PROMPT || typeof GAME_BIBLE_PROMPT !== 'string' || GAME_BIBLE_PROMPT.trim() === '') {
        throw new Error("FATAL ERROR: Prompt loaded from DB is empty/null. Check table 'prompts', column 'prompt'.");
    }

    console.log("System Prompt successfully loaded. Length:", GAME_BIBLE_PROMPT.length);

    // 3. Získanie anglických zdrojových textov
    const { data: enRecords, error: fetchError } = await supabase
      .from("translations")
      .select("*")
      .eq("language_code", "en");

    if (fetchError) throw fetchError;
    if (!enRecords || enRecords.length === 0) {
      return new Response(JSON.stringify({ success: true, message: "No English records found." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const report: any = { 
        total: enRecords.length, 
        processed_batches: 0, 
        review_items: [],
        warnings: []
    };

    // 4. Spracovanie po dávkach
    for (let i = 0; i < enRecords.length; i += BATCH_SIZE) {
      const batch = enRecords.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(enRecords.length / BATCH_SIZE);
      console.log(`Processing batch ${batchNum}/${totalBatches} (${batch.length} items)...`);

      const inputForAI = {};
      const metaMap = new Map();

      batch.forEach((row) => {
        inputForAI[row.translation_key] = row.translated_text;
        metaMap.set(row.translation_key, { category: row.category, source: row.translated_text });
      });

      let success = false;
      let retries = 0;
      const MAX_RETRIES = 5;

      while (!success && retries < MAX_RETRIES) {
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
                  { role: "system", content: GAME_BIBLE_PROMPT }, 
                  {
                    role: "user",
                    content: `TASK: Translate JSON from English to "${fullLanguageName}" (Code: ${target_language}).\nJSON INPUT:\n${JSON.stringify(inputForAI)}`,
                  },
                ],
                response_format: { type: "json_object" },
              }),
            });

            if (completion.status === 429) {
                console.warn(`⚠️ Rate Limit Reached for batch ${batchNum}. Waiting ${RATE_LIMIT_DELAY_MS/1000}s before retry...`);
                await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
                retries++;
                continue; 
            }

            if (!completion.ok) {
                const errorText = await completion.text();
                throw new Error(`Groq API Error: ${errorText}`);
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

            const dbPayload = [];
            
            Object.keys(translations).forEach((key) => {
                const cleanKey = key.trim();
                
                if (metaMap.has(cleanKey)) {
                    const translated = translations[key];
                    const original = metaMap.get(cleanKey).source;
                    const note = notes[key] || null;

                    dbPayload.push({
                        translation_key: cleanKey,
                        language_code: target_language,
                        translated_text: translated,
                        category: metaMap.get(cleanKey).category,
                        last_updated: new Date().toISOString()
                    });

                    const isIdentical = translated === original && isNaN(Number(original)) && original.length > 1;
                    
                    if (isIdentical || note) {
                        report.review_items.push({
                            lang: target_language,
                            key: cleanKey,
                            en: original,
                            target: translated,
                            reason: note || (isIdentical ? "Identical to English (No note provided)" : "AI Note"),
                            type: isIdentical ? "Untranslated" : "AI Adaptation"
                        });
                    }
                }
            });

            if (dbPayload.length > 0) {
                const { error: upsertError } = await supabase
                    .from("translations")
                    .upsert(dbPayload, { onConflict: "translation_key,language_code" });
                if (upsertError) throw upsertError;
            }

            report.processed_batches++;
            success = true; 

          } catch (err) {
            console.error(`Error attempting batch ${batchNum} (Attempt ${retries + 1}):`, err);
            if (retries === MAX_RETRIES - 1) {
                 report.warnings.push({ batch: batchNum, msg: err.message });
            }
            retries++;
            if (!success && retries < MAX_RETRIES) await new Promise(r => setTimeout(r, 2000));
          }
      } 

      if (i + BATCH_SIZE < enRecords.length) {
        await new Promise((resolve) => setTimeout(resolve, STANDARD_DELAY_MS));
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