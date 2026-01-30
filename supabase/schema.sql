CREATE TABLE languages (
    code VARCHAR(5) PRIMARY KEY,
    name TEXT NOT NULL, 
    is_active BOOLEAN DEFAULT true,
    percent_translated number not null default 0,
);

CREATE TABLE translations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    translation_key TEXT NOT NULL,
    language_code VARCHAR(5) REFERENCES languages(code) ON DELETE CASCADE,
    translated_text TEXT NOT NULL,
    category TEXT,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(translation_key, language_code)
);

CREATE TABLE prompts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prompt TEXT NOT NULL,
    name TEXT NOT NULL
);

CREATE INDEX idx_translations_key ON translations(translation_key);