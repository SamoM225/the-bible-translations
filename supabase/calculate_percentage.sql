DROP TRIGGER IF EXISTS tr_refresh_percent ON translations;
DROP FUNCTION IF EXISTS update_translation_percentages;

CREATE OR REPLACE FUNCTION update_translation_percentages()
RETURNS TRIGGER AS $$
DECLARE
    en_count FLOAT;
BEGIN
    SELECT COUNT(*)::FLOAT INTO en_count FROM translations WHERE language_code = 'en';

    IF en_count = 0 THEN
        UPDATE languages SET percent_translated = 0 WHERE true;
        RETURN NULL;
    END IF;


    UPDATE languages l
    SET percent_translated = (
        SELECT COUNT(*) 
        FROM translations t 
        WHERE t.language_code = l.code
    )::FLOAT / en_count * 100
    WHERE l.code IS NOT NULL; 

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_refresh_percent
AFTER INSERT OR DELETE ON translations
FOR EACH STATEMENT
EXECUTE FUNCTION update_translation_percentages();