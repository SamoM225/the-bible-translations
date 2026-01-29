<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { supabase } from '../lib/supabase'

type Row = {
  id: string
  translation_key?: string
  language_code?: string
  translated_text?: string
  category?: string | null
  last_updated?: string | null
  [key: string]: unknown
}

type TranslationEntry = {
  language_code: string
  translated_text: string
  id?: string
}

type PivotRow = {
  translation_key: string
  category?: string | null
  last_updated?: string | null
  translations: Record<string, { id?: string; text: string }>
}

type Language = {
  code: string
  name: string
  is_active: boolean
  percent_translated?: number | null
}

type BatchRow = {
  translation_key: string
  source_text: string
  category?: string
}

type BatchReportItem = {
  lang: string
  key: string
  en: string
  target: string
  reason: string
  type: string
}

type BatchReport = {
  processed: string[]
  warnings: string[]
  review_items: BatchReportItem[]
}

type LanguageEdgeResponse = {
  success: boolean
  finished: boolean
  next_offset?: number | null
  report?: {
    review_items?: BatchReportItem[]
  }
}

const tableName = 'translations'

const rows = ref<Row[]>([])
const languages = ref<Language[]>([])
const isLoading = ref(false)
const errorMessage = ref('')
const search = ref('')

const showLanguageModal = ref(false)
const showTranslationModal = ref(false)
const showLanguageSelectModal = ref(false)
const showBatchModal = ref(false)
const showPromptsModal = ref(false)

const selectedLanguageCodes = ref<string[]>([])

const perPagePreset = ref('25')
const customPerPage = ref(25)
const currentPage = ref(1)

const isEditMode = ref(false)
const editingKey = ref<string | null>(null)

const selectedKeys = ref<string[]>([])

const languageForm = ref({
  code: '',
  name: '',
  is_active: true,
})

const translationForm = ref<{
  translation_key: string
  category: string
  translations: TranslationEntry[]
}>({
  translation_key: '',
  category: '',
  translations: [],
})

const nameFilter = ref('')

const batchFileName = ref('')
const batchDelimiter = ref('')
const batchRows = ref<BatchRow[]>([])
const batchError = ref('')
const batchIsParsing = ref(false)
const batchIsSending = ref(false)
const batchReport = ref<BatchReport | null>(null)
const isAddingLanguage = ref(false)
const notifyMessage = ref('')
const notifyType = ref<'success' | 'error'>('success')
const prompts = ref<Array<{ name: string; prompt: string }>>([])
const promptsLoading = ref(false)
const promptsSaving = ref(false)
const promptsError = ref('')
const selectedPromptName = ref('')
const newPromptName = ref('')
const promptText = ref('')
const isWipingAll = ref(false)

const selectedLanguagesLabel = computed(() => {
  if (!selectedLanguageCodes.value.length) {
    return ''
  }
  if (selectedLanguageCodes.value.length === languages.value.length) {
    return 'Vsetky jazyky'
  }
  return selectedLanguageCodes.value
    .map((code) => languages.value.find((lang) => lang.code === code)?.name || code)
    .join(', ')
})

const allLanguagesSelected = computed(() => {
  return languages.value.length > 0 && selectedLanguageCodes.value.length === languages.value.length
})

const promptNames = computed(() => prompts.value.map((item) => item.name))

const languageLabelMap = computed(() => {
  const map = new Map<string, string>()
  languages.value.forEach((lang) => {
    map.set(lang.code, `${lang.name} (${lang.code})`)
  })
  return map
})

const getLanguageLabel = (code: string) => {
  return languageLabelMap.value.get(code) ?? code
}

const tableRows = computed<PivotRow[]>(() => {
  const grouped = new Map<string, PivotRow>()
  rows.value.forEach((row) => {
    const key = String(row.translation_key ?? '').trim()
    if (!key) {
      return
    }
    const existing = grouped.get(key)
    const entry =
      existing ??
      ({
        translation_key: key,
        category: row.category ?? null,
        last_updated: row.last_updated ?? null,
        translations: {},
      } satisfies PivotRow)

    if (!existing) {
      grouped.set(key, entry)
    }

    if (!entry.category && row.category) {
      entry.category = row.category
    }

    if (row.last_updated) {
      const current = entry.last_updated ? new Date(entry.last_updated).getTime() : 0
      const next = new Date(row.last_updated).getTime()
      if (!Number.isNaN(next) && next > current) {
        entry.last_updated = row.last_updated
      }
    }

    const lang = String(row.language_code ?? '').trim()
    if (lang) {
      entry.translations[lang] = {
        id: row.id,
        text: String(row.translated_text ?? ''),
      }
    }
  })

  return Array.from(grouped.values()).sort((a, b) =>
    a.translation_key.localeCompare(b.translation_key)
  )
})

const visibleRows = computed(() => {
  if (!search.value.trim()) {
    return tableRows.value
  }
  const query = search.value.toLowerCase()
  return tableRows.value.filter((row) => {
    if (row.translation_key.toLowerCase().includes(query)) {
      return true
    }
    if (String(row.category ?? '').toLowerCase().includes(query)) {
      return true
    }
    if (String(row.last_updated ?? '').toLowerCase().includes(query)) {
      return true
    }
    return Object.values(row.translations).some((entry) =>
      String(entry.text ?? '').toLowerCase().includes(query)
    )
  })
})

const filteredRows = computed(() => {
  const nameQuery = nameFilter.value.trim().toLowerCase()

  return visibleRows.value.filter((row) => {
    if (nameQuery) {
      const key = String(row.translation_key ?? '').toLowerCase()
      if (!key.includes(nameQuery)) {
        return false
      }
    }

    return true
  })
})

const perPage = computed(() => {
  if (perPagePreset.value === 'custom') {
    return Math.max(1, customPerPage.value || 1)
  }
  return Number(perPagePreset.value)
})

const totalPages = computed(() => {
  return Math.max(1, Math.ceil(filteredRows.value.length / perPage.value))
})

const paginatedRows = computed(() => {
  const start = (currentPage.value - 1) * perPage.value
  return filteredRows.value.slice(start, start + perPage.value)
})

const columns = computed(() => {
  const selected =
    selectedLanguageCodes.value.length > 0
      ? selectedLanguageCodes.value
      : languages.value.map((lang) => lang.code)
  const languageColumns = selected.map((code) => {
    const name = languages.value.find((lang) => lang.code === code)?.name
    return {
      key: code,
      label: name ? `${name} (${code})` : code,
    }
  })
  return [
    { key: 'translation_key', label: 'translation_key' },
    ...languageColumns,
  ] as Array<{ key: string; label: string }>
})

const allSelectedOnPage = computed(() => {
  if (!paginatedRows.value.length) {
    return false
  }
  return paginatedRows.value.every((row) => selectedKeys.value.includes(row.translation_key))
})

const loadRows = async () => {
  if (!selectedLanguageCodes.value.length) {
    rows.value = []
    return
  }
  isLoading.value = true
  errorMessage.value = ''

  const allRows: Row[] = []
  const pageSize = 1000
  let fromIndex = 0
  let keepLoading = true

  while (keepLoading) {
    const toIndex = fromIndex + pageSize - 1
    const { data, error } = await supabase
      .from(tableName)
      .select('*')
      .in('language_code', selectedLanguageCodes.value || [])
      .range(fromIndex, toIndex)

    if (error) {
      errorMessage.value = error.message
      rows.value = []
      isLoading.value = false
      return
    }

    const batch = (data ?? []) as Row[]
    allRows.push(...batch)

    if (batch.length < pageSize) {
      keepLoading = false
    } else {
      fromIndex += pageSize
    }
  }

  rows.value = allRows
  isLoading.value = false
}

const loadLanguages = async () => {
  const wasAllSelected = allLanguagesSelected.value
  const { data } = await supabase
    .from('languages')
    .select('code, name, is_active, percent_translated')
    .order('name')
  languages.value = data ?? []
  if ((wasAllSelected || !selectedLanguageCodes.value.length) && languages.value.length) {
    selectedLanguageCodes.value = languages.value.map((lang) => lang.code)
  }
}

const toggleSelectAllLanguages = () => {
  if (allLanguagesSelected.value) {
    selectedLanguageCodes.value = []
    return
  }
  selectedLanguageCodes.value = languages.value.map((lang) => lang.code)
}

const buildTranslationEntries = (row?: PivotRow) => {
  const languageList =
    selectedLanguageCodes.value.length > 0
      ? selectedLanguageCodes.value
      : languages.value.map((lang) => lang.code)
  return languageList.map((code) => ({
    language_code: code,
    translated_text: row?.translations[code]?.text ?? '',
    id: row?.translations[code]?.id,
  }))
}

const confirmLanguageSelection = async () => {
  if (!selectedLanguageCodes.value.length) {
    return
  }
  showLanguageSelectModal.value = false
  if (!showTranslationModal.value) {
    translationForm.value.translations = buildTranslationEntries()
  }
  await loadRows()
}

const resetLanguageForm = () => {
  languageForm.value = { code: '', name: '', is_active: true }
}

const showNotification = (message: string, type: 'success' | 'error' = 'success') => {
  notifyMessage.value = message
  notifyType.value = type
}

const resetTranslationForm = () => {
  translationForm.value = {
    translation_key: '',
    category: '',
    translations: buildTranslationEntries(),
  }
  isEditMode.value = false
  editingKey.value = null
}

const resetFilters = () => {
  nameFilter.value = ''
}

const resetBatch = () => {
  batchFileName.value = ''
  batchDelimiter.value = ''
  batchRows.value = []
  batchError.value = ''
  batchIsParsing.value = false
  batchIsSending.value = false
  batchReport.value = null
}

const resetPromptForm = () => {
  selectedPromptName.value = ''
  newPromptName.value = ''
  promptText.value = ''
  promptsError.value = ''
}

const openAddTranslation = () => {
  resetTranslationForm()
  showTranslationModal.value = true
}

const openBatchUpload = () => {
  resetBatch()
  showBatchModal.value = true
}

const openPromptsModal = async () => {
  resetPromptForm()
  showPromptsModal.value = true
  await loadPrompts()
}

const openEditTranslation = (row: PivotRow) => {
  translationForm.value = {
    translation_key: row.translation_key,
    category: String(row.category ?? ''),
    translations: buildTranslationEntries(row),
  }
  isEditMode.value = true
  editingKey.value = row.translation_key
  showTranslationModal.value = true
}

const addLanguage = async () => {
  errorMessage.value = ''
  isAddingLanguage.value = true
  const payload = {
    code: (languageForm.value.code ?? '').trim(),
    name: (languageForm.value.name ?? '').trim(),
    is_active: languageForm.value.is_active,
  }

  const { error } = await supabase.from('languages').upsert(payload, { onConflict: 'code' })
  if (error) {
    errorMessage.value = error.message
    isAddingLanguage.value = false
    return
  }

  const callEdge = async (offset: number) => {
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData.session?.access_token

    const response = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/add-language-translation`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ target_language: payload.code, offset }),
      }
    )

    const responseBody = (await response.json().catch(() => null)) as LanguageEdgeResponse | null
    if (!response.ok || responseBody?.success === false) {
      throw new Error('Nepodarilo sa spustit edge funkciu pre preklady.')
    }
    return responseBody
  }

  const reviewItems: BatchReportItem[] = []

  const processBatch = async (offset: number) => {
    try {
      const responseBody = await callEdge(offset)

      if (responseBody?.report?.review_items?.length) {
        reviewItems.push(...responseBody.report.review_items)
      }

      if (responseBody?.finished) {
        showNotification('Jazyk uspesne pridany a prelozeny.', 'success')
        isAddingLanguage.value = false
        return
      }

      const nextOffset =
        typeof responseBody?.next_offset === 'number' ? responseBody.next_offset : null

      if (nextOffset === null || Number.isNaN(nextOffset)) {
        showNotification('Jazyk uspesne pridany a prelozeny.', 'success')
        isAddingLanguage.value = false
        return
      }

      await processBatch(nextOffset)
    } catch (err) {
      errorMessage.value =
        err instanceof Error ? err.message : 'Nepodarilo sa spustit edge funkciu pre preklady.'
      showNotification('Preklad zlyhal. Skusim znovu o 30s.', 'error')
      window.setTimeout(() => {
        void processBatch(offset)
      }, 30000)
    }
  }

  await processBatch(0)

  await loadLanguages()
  await loadRows()
  resetLanguageForm()
  showLanguageModal.value = false
}

const wipeAllData = async () => {
  const first = window.confirm(
    'Naozaj chcete vymazat VSETKY data?.'
  )
  if (!first) {
    return
  }
  const second = window.confirm('Potvrdte ESTE RAZ. Tato akcia je nevratna.')
  if (!second) {
    return
  }

  isWipingAll.value = true
  errorMessage.value = ''

  const { error: translationError } = await supabase
    .from('translations')
    .delete()
    .not('id', 'is', null)

  if (translationError) {
    errorMessage.value = translationError.message
    showNotification('Zlyhalo mazanie translations.', 'error')
    isWipingAll.value = false
    return
  }

  const { error: languageError } = await supabase.from('languages').delete().neq('code', 'en')
  if (languageError) {
    errorMessage.value = languageError.message
    showNotification('Zlyhalo mazanie languages.', 'error')
    isWipingAll.value = false
    return
  }

  selectedKeys.value = []
  await Promise.all([loadLanguages(), loadRows()])
  showNotification('Vsetky data boli vymazane, zostala iba anglictina.', 'success')
  isWipingAll.value = false
}

const loadPrompts = async () => {
  promptsLoading.value = true
  promptsError.value = ''
  const { data, error } = await supabase.from('prompts').select('name, prompt').order('name')
  if (error) {
    promptsError.value = error.message
    prompts.value = []
  } else {
    prompts.value = data ?? []
  }
  promptsLoading.value = false
}

const savePrompt = async () => {
  promptsError.value = ''
  promptsSaving.value = true
  const name = selectedPromptName.value === '__new__' ? newPromptName.value.trim() : selectedPromptName.value
  if (!name || !promptText.value.trim()) {
    promptsError.value = 'Vyplnte nazov a text promptu.'
    promptsSaving.value = false
    return
  }

  // Check if prompt with this name already exists
  const { data: existingPrompt, error: checkError } = await supabase
    .from('prompts')
    .select('name')
    .eq('name', name)
    .single()

  if (checkError && checkError.code !== 'PGRST116') {
    // PGRST116 means no rows found, which is expected for new prompts
    promptsError.value = checkError.message
    promptsSaving.value = false
    return
  }

  let error
  if (existingPrompt) {
    // Update existing prompt
    const result = await supabase.from('prompts').update({ prompt: promptText.value.trim() }).eq('name', name)
    error = result.error
  } else {
    // Insert new prompt
    const result = await supabase.from('prompts').insert({ name, prompt: promptText.value.trim() })
    error = result.error
  }

  if (error) {
    promptsError.value = error.message
    promptsSaving.value = false
    return
  }

  await loadPrompts()
  selectedPromptName.value = name
  newPromptName.value = ''
  promptsSaving.value = false
}

const saveTranslations = async () => {
  errorMessage.value = ''
  const translationKey = translationForm.value.translation_key.trim()
  if (!translationKey) {
    errorMessage.value = 'Vyplnte translation key.'
    return
  }

  const category = (translationForm.value.category ?? '').trim() || null
  const originalKey = editingKey.value

  if (originalKey) {
    const updatePayload = {
      translation_key: translationKey,
      category,
    }
    const { error } = await supabase
      .from('translations')
      .update(updatePayload)
      .eq('translation_key', originalKey)
    if (error) {
      errorMessage.value = error.message
      return
    }
  }

  const inserts: Array<{
    translation_key: string
    language_code: string
    translated_text: string
    category: string | null
  }> = []

  const seenLanguages = new Set<string>()

  for (const entry of translationForm.value.translations) {
    const languageCode = entry.language_code
    if (!languageCode || seenLanguages.has(languageCode)) {
      continue
    }
    seenLanguages.add(languageCode)
    const translatedText = (entry.translated_text ?? '').trim()

    if (entry.id) {
      const { error } = await supabase
        .from('translations')
        .update({
          translated_text: translatedText,
          language_code: languageCode,
        })
        .eq('id', entry.id)
      if (error) {
        errorMessage.value = error.message
        return
      }
      continue
    }

    if (translatedText) {
      inserts.push({
        translation_key: translationKey,
        language_code: languageCode,
        translated_text: translatedText,
        category,
      })
    }
  }

  if (inserts.length) {
    const { error } = await supabase.from('translations').insert(inserts)
    if (error) {
      errorMessage.value = error.message
      return
    }
  }

  await loadRows()
  resetTranslationForm()
  showTranslationModal.value = false
}

const addTranslation = async () => {
  editingKey.value = null
  await saveTranslations()
}

const updateTranslation = async () => {
  await saveTranslations()
}

const removeTranslations = async (keys: string[]) => {
  if (!keys.length) {
    return
  }
  const confirmed = window.confirm(`Naozaj chcete vymazat ${keys.length} kluc(ov)?`)
  if (!confirmed) {
    return
  }
  errorMessage.value = ''
  const { error } = await supabase.from('translations').delete().in('translation_key', keys)
  if (error) {
    errorMessage.value = error.message
    return
  }
  selectedKeys.value = selectedKeys.value.filter((key) => !keys.includes(key))
  await loadRows()
}

const toggleSelectRow = (key: string) => {
  if (selectedKeys.value.includes(key)) {
    selectedKeys.value = selectedKeys.value.filter((selected) => selected !== key)
  } else {
    selectedKeys.value = [...selectedKeys.value, key]
  }
}

const toggleSelectAllOnPage = () => {
  if (allSelectedOnPage.value) {
    const pageKeys = paginatedRows.value.map((row) => row.translation_key)
    selectedKeys.value = selectedKeys.value.filter((key) => !pageKeys.includes(key))
    return
  }
  const pageKeys = paginatedRows.value.map((row) => row.translation_key)
  const combined = new Set([...selectedKeys.value, ...pageKeys])
  selectedKeys.value = Array.from(combined)
}

const goToPage = (page: number) => {
  const next = Math.min(Math.max(1, page), totalPages.value)
  currentPage.value = next
}

const detectDelimiter = (text: string) => {
  const sample = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 5)
  const candidates = [',', ';', '\t', '|']
  let best = ','
  let bestScore = 0

  for (const candidate of candidates) {
    const counts = sample.map((line) => line.split(candidate).length)
    const score = counts.length ? Math.min(...counts) : 0
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }

  return best
}

const parseCsvLine = (line: string, delimiter: string) => {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    const next = line[i + 1]

    if (char === '"' && inQuotes && next === '"') {
      current += '"'
      i += 1
      continue
    }

    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }

    if (char === delimiter && !inQuotes) {
      result.push(current.trim())
      current = ''
      continue
    }

    current += char
  }

  result.push(current.trim())
  return result
}

const parseDelimitedText = (text: string, delimiter: string) => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (!lines.length) {
    return [] as BatchRow[]
  }

  const headerLine = (lines[0] ?? '').replace(/^\uFEFF/, '')
  let header = parseCsvLine(headerLine, delimiter).map((item) => item.trim().toLowerCase())

  // If header has only one item and it contains the delimiter, it might be a malformed CSV
  // Try re-parsing the header without treating it as a CSV line
  if (header.length === 1 && (header[0]?.includes(delimiter) ?? false)) {
    header = (header[0] ?? '').split(delimiter).map((item) => item.trim().toLowerCase())
  }

  // Find translation_key column
  const translationKeyIndex = header.indexOf('translation_key')
  // Find source_text or translated_text column
  const sourceTextIndex = header.indexOf('source_text')
  const translatedTextIndex = header.indexOf('translated_text')
  const textIndex = sourceTextIndex >= 0 ? sourceTextIndex : translatedTextIndex
  // Find category column
  const categoryIndex = header.indexOf('category')

  if (translationKeyIndex === -1 || textIndex === -1) {
    throw new Error('CSV/TSV musi obsahovat stlpce: translation_key a source_text (alebo translated_text). Nadene stlpce: ' + header.join(', '))
  }

  return lines.slice(1).map((line) => {
    const parts = parseCsvLine(line, delimiter)
    return {
      translation_key: parts[translationKeyIndex] ?? '',
      source_text: parts[textIndex] ?? '',
      category: categoryIndex >= 0 ? parts[categoryIndex] ?? '' : '',
    }
  })
}

const parseXml = (text: string) => {
  const parser = new DOMParser()
  const xml = parser.parseFromString(text, 'application/xml')
  if (xml.querySelector('parsererror')) {
    throw new Error('XML nie je validne')
  }

  const items = Array.from(xml.querySelectorAll('translation, item, row'))
  if (!items.length) {
    throw new Error('XML neobsahuje ziadne <translation> alebo <item> prvky')
  }

  return items.map((item) => {
    const getValue = (key: string) =>
      item.querySelector(key)?.textContent?.trim() || item.getAttribute(key) || ''

    return {
      translation_key: getValue('translation_key'),
      source_text: getValue('source_text') || getValue('translated_text'),
      category: getValue('category'),
    }
  })
}

const parseBatchFile = async (file: File) => {
  batchError.value = ''
  batchIsParsing.value = true

  const text = await file.text()
  const isXml = file.name.toLowerCase().endsWith('.xml') || text.trim().startsWith('<')

  try {
    let parsed: BatchRow[] = []

    if (isXml) {
      parsed = parseXml(text)
      batchDelimiter.value = 'XML'
    } else {
      const delimiter = detectDelimiter(text)
      batchDelimiter.value = delimiter === '\t' ? 'TAB' : delimiter
      parsed = parseDelimitedText(text, delimiter)
    }

    batchRows.value = parsed.filter((row) => row.translation_key && row.source_text)

    if (!batchRows.value.length) {
      throw new Error('Subor neobsahuje platne riadky')
    }
  } catch (err) {
    batchRows.value = []
    batchError.value = err instanceof Error ? err.message : 'Nepodarilo sa nacitat subor'
  } finally {
    batchIsParsing.value = false
  }
}

const handleBatchFileInput = async (event: Event) => {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) {
    return
  }
  batchFileName.value = file.name
  await parseBatchFile(file)
}

const submitBatch = async () => {
  if (!batchRows.value.length) {
    return
  }
  batchIsSending.value = true
  batchError.value = ''
  batchReport.value = null

  try {
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData.session?.access_token

    const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/rapid-task`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ rows: batchRows.value }),
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const message = payload?.error || 'Edge funkcia vratila chybu'
      throw new Error(message)
    }

    batchReport.value = payload?.report ?? null
    await loadRows()
  } catch (err) {
    batchError.value = err instanceof Error ? err.message : 'Nepodarilo sa odoslat batch'
  } finally {
    batchIsSending.value = false
  }
}

const exportCsv = (filename: string, header: string[], rows: string[][]) => {
  const lines = rows.map((row) =>
    row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',')
  )
  const csv = [header.join(','), ...lines].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

const exportBatchReview = () => {
  if (!batchReport.value?.review_items?.length) {
    return
  }
  const header = ['lang', 'key', 'en', 'target', 'reason', 'type']
  const rows = batchReport.value.review_items.map((item) => [
    item.lang,
    item.key,
    item.en,
    item.target,
    item.reason,
    item.type,
  ])
  exportCsv('batch-review-items.csv', header, rows)
}

const exportBatchAll = () => {
  if (!batchRows.value.length) {
    return
  }
  const header = ['translation_key', 'source_text', 'category']
  const rows = batchRows.value.map((row) => [
    row.translation_key,
    row.source_text,
    row.category ?? '',
  ])
  exportCsv('batch-import.csv', header, rows)
}

const exportBatchTemplate = () => {
  const header = ['translation_key', 'source_text', 'category']
  const rows = [
    ['home.title', 'Home', 'ui'],
    ['card.driver', 'Driver', ''],
  ]
  exportCsv('batch-template.csv', header, rows)
}

watch([visibleRows, perPage, nameFilter], () => {
  currentPage.value = 1
})

watch(totalPages, (pages) => {
  if (currentPage.value > pages) {
    currentPage.value = pages
  }
})

watch(selectedLanguageCodes, () => {
  selectedKeys.value = []
  currentPage.value = 1
  if (!showTranslationModal.value) {
    translationForm.value.translations = buildTranslationEntries()
  }
})

watch(selectedPromptName, () => {
  if (selectedPromptName.value === '__new__') {
    promptText.value = ''
    newPromptName.value = ''
    return
  }
  const found = prompts.value.find((item) => item.name === selectedPromptName.value)
  promptText.value = found?.prompt ?? ''
})

onMounted(async () => {
  await loadLanguages()
  resetTranslationForm()
  await loadRows()
})
</script>

<template>
  <div class="dash-shell">
    <header class="dash-header">
      <div>
        <p class="dash-kicker">Admin</p>
        <h1>Dashboard</h1>
        <p class="dash-subtitle">
          Prehlad dat z tabulky <strong>{{ tableName }}</strong>
          <span v-if="selectedLanguagesLabel">({{ selectedLanguagesLabel }})</span>.
        </p>
      </div>
      <div class="dash-actions">
        <input v-model="search" type="search" placeholder="Hladat v tabulke" />
        <button class="ghost" type="button" @click="showLanguageSelectModal = true">
          Zmenit jazyk
        </button>
        <button class="ghost" type="button" @click="loadRows">Obnovit</button>
        <button class="primary batch" type="button" @click="openBatchUpload">Importovat slova</button>
        <button class="ghost" type="button" @click="openPromptsModal">Upravit prompty</button>
        <button class="ghost danger" type="button" :disabled="isWipingAll" @click="wipeAllData">
          {{ isWipingAll ? 'Mazem...' : 'Vymazat vsetko' }}
        </button>
        <button class="ghost" type="button" @click="showLanguageModal = true">Pridat jazyk</button>
        <button v-if="selectedKeys.length" class="ghost danger" type="button" @click="removeTranslations(selectedKeys)">
          Vymazat vybrane ({{ selectedKeys.length }})
        </button>
      </div>
    </header>

    <section class="dash-card">
      <div class="table-meta">
        <span v-if="isLoading">Nacitavam data...</span>
        <span v-else-if="errorMessage" class="error">{{ errorMessage }}</span>
        <span v-else>Celkom riadkov: {{ filteredRows.length }}</span>
      </div>

      <div class="table-controls">
        <div class="per-page">
          <label>
            <span>Na stranu</span>
            <select v-model="perPagePreset">
              <option value="10">10</option>
              <option value="25">25</option>
              <option value="100">100</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <input v-if="perPagePreset === 'custom'" v-model.number="customPerPage" type="number" min="1" max="200"
            placeholder="napr. 50" />
        </div>
        <div class="pager">
          <button class="ghost" type="button" :disabled="currentPage === 1" @click="goToPage(1)">
            Prva
          </button>
          <button class="ghost" type="button" :disabled="currentPage === 1" @click="goToPage(currentPage - 1)">
            Predchadzajuca
          </button>
          <span>Strana {{ currentPage }} / {{ totalPages }}</span>
          <button class="ghost" type="button" :disabled="currentPage === totalPages" @click="goToPage(currentPage + 1)">
            Dalsia
          </button>
          <button class="ghost" type="button" :disabled="currentPage === totalPages" @click="goToPage(totalPages)">
            Posledna
          </button>
        </div>
      </div>

      <div class="filter-bar">
        <label>
          <span>Nazov (key)</span>
          <input v-model="nameFilter" type="search" placeholder="napr. home.title" />
        </label>
        <button class="ghost" type="button" @click="resetFilters">Vymazať filtre</button>
      </div>

      <div class="table-wrap">
        <table v-if="columns.length && paginatedRows.length" class="data-table">
          <thead>
            <tr>
              <th class="select-col">
                <input type="checkbox" :checked="allSelectedOnPage" @change="toggleSelectAllOnPage"
                  aria-label="Select all" />
              </th>
              <th v-for="column in columns" :key="column.key">{{ column.label }}</th>
              <th class="actions-col"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in paginatedRows" :key="row.translation_key" class="data-row">
              <td class="select-col">
                <input type="checkbox" :checked="selectedKeys.includes(row.translation_key)"
                  @change="toggleSelectRow(row.translation_key)" aria-label="Select row" />
              </td>
              <td v-for="column in columns" :key="column.key">
                <span v-if="column.key === 'translation_key'">{{ row.translation_key }}</span>
                <span v-else>{{ row.translations[column.key]?.text ?? '-' }}</span>
              </td>
              <td class="actions-col">
                <div class="row-actions">
                  <button class="ghost" type="button" @click="openEditTranslation(row)">
                    Upravit
                  </button>
                  <button class="ghost danger" type="button" @click="removeTranslations([row.translation_key])">
                    Vymazat
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>

        <div v-else class="empty">
          <p>Nie su dostupne ziadne data.</p>
          <p>Skontroluj, ci tabulka <strong>{{ tableName }}</strong> existuje v Supabase.</p>
        </div>
      </div>
    </section>

    <div v-if="showLanguageSelectModal" class="modal-backdrop" @click.self="showLanguageSelectModal = false">
      <div class="modal modal-scroll">
        <header>
          <div>
            <p class="modal-kicker">Languages</p>
            <h2>Vyber jazyky</h2>
            <p class="modal-subtitle">Mizes vybrat viacero alebo vsetky jazyky.</p>
          </div>
          <button class="icon" type="button" @click="showLanguageSelectModal = false">x</button>
        </header>
        <div class="language-toolbar">
          <label class="language-toggle">
            <input type="checkbox" :checked="allLanguagesSelected" @change="toggleSelectAllLanguages" />
            <span>Vybrat vsetky</span>
          </label>
          <button class="ghost" type="button" @click="selectedLanguageCodes = []">Vycistit</button>
        </div>
        <div class="language-grid">
          <label v-for="lang in languages" :key="lang.code" class="language-card">
            <input type="checkbox" :value="lang.code" v-model="selectedLanguageCodes" />
            <div>
              <strong>{{ lang.name }}</strong>
              <span>{{ lang.code }}</span>
            </div>
            <div class="progress">
              <span>{{ lang.percent_translated ?? 0 }}%</span>
              <div class="bar">
                <div class="fill" :style="{ width: `${lang.percent_translated ?? 0}%` }"></div>
              </div>
            </div>
          </label>
        </div>
        <div class="modal-actions">
          <button class="ghost" type="button" @click="showLanguageSelectModal = false">
            Zatvorit
          </button>
          <button class="primary" type="button" :disabled="!selectedLanguageCodes.length"
            @click="confirmLanguageSelection">
            Pokracovat
          </button>
        </div>
      </div>
    </div>

    <div v-if="showBatchModal" class="modal-backdrop" @click.self="showBatchModal = false">
      <div class="modal modal-scroll">
        <header>
          <div>
            <p class="modal-kicker">Batch import</p>
            <h2>Import prekladov</h2>
            <p class="modal-subtitle">
              CSV/TSV/TXT alebo XML s polami translation_key, source_text (alebo translated_text),
              category
            </p>
          </div>
          <button class="icon" type="button" @click="showBatchModal = false">x</button>
        </header>
        <div class="batch-scroll">
          <div class="batch-upload">
            <input type="file" accept=".csv,.tsv,.txt,.xml" @change="handleBatchFileInput" />
            <button class="ghost" type="button" @click="exportBatchTemplate">
              Stiahnut CSV template
            </button>
            <div class="batch-meta" v-if="batchFileName">
              <span><strong>Subor:</strong> {{ batchFileName }}</span>
              <span v-if="batchDelimiter"><strong>Delimiter:</strong> {{ batchDelimiter }}</span>
              <span><strong>Riadkov:</strong> {{ batchRows.length }}</span>
            </div>
            <p v-if="batchIsParsing">Spracuvavam subor...</p>
            <p v-if="batchError" class="error">{{ batchError }}</p>
          </div>

          <div v-if="batchRows.length" class="batch-preview">
            <div class="batch-table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>translation_key</th>
                    <th>source_text</th>
                    <th>category</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, index) in batchRows.slice(0, 10)" :key="index">
                    <td>{{ row.translation_key }}</td>
                    <td>{{ row.source_text }}</td>
                    <td>{{ row.category || '-' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p class="batch-hint">Zobrazenych 10 z {{ batchRows.length }} riadkov.</p>
          </div>

          <div v-if="batchIsSending" class="batch-loading">
            <svg class="spinner-icon" viewBox="0 0 50 50" role="img" aria-label="Loading">
              <circle class="spinner-track" cx="25" cy="25" r="20" fill="none" stroke-width="4" />
              <circle class="spinner-head" cx="25" cy="25" r="20" fill="none" stroke-width="4" />
            </svg>
            <p>Pockajte kym sa data spracuju</p>
            <div class="skeleton">
              <div class="skeleton-bar"></div>
              <div class="skeleton-bar"></div>
              <div class="skeleton-bar"></div>
            </div>
          </div>

          <div v-if="batchReport" class="batch-report">
            <h3>Batch Report</h3>
            <div v-if="batchReport.review_items?.length" class="batch-report-section">
              <h4>Polozky na kontrolu ({{ batchReport.review_items.length }})</h4>
              <div class="batch-report-buttons">
                <button class="ghost" type="button" @click="exportBatchReview">Export review items</button>
              </div>
            </div>
            <div v-if="batchReport.warnings?.length" class="batch-report-section">
              <h4>Varovania ({{ batchReport.warnings.length }})</h4>
              <ul>
                <li v-for="(warning, index) in batchReport.warnings" :key="index">{{ warning }}</li>
              </ul>
            </div>
            <div v-if="batchReport.processed?.length" class="batch-report-section">
              <h4>Spracovane prvky ({{ batchReport.processed.length }})</h4>
              <p>{{ batchReport.processed.length }} riadkov bolo uspesne spracovanych.</p>
            </div>
          </div>
        </div>

        <div class="modal-actions">
          <button class="ghost" type="button" @click="showBatchModal = false">Zatvorit</button>
          <button class="primary" type="button" :disabled="!batchRows.length || batchIsSending" @click="submitBatch">
            {{ batchIsSending ? 'Odosielam...' : 'Importovat' }}
          </button>
          <button class="ghost" type="button" @click="exportBatchAll">Export all</button>
        </div>
      </div>
    </div>

    <div v-if="showPromptsModal" class="modal-backdrop" @click.self="showPromptsModal = false">
      <div class="modal modal-scroll">
        <header>
          <div>
            <p class="modal-kicker">Prompts</p>
            <h2>Uprava promptov</h2>
            <p class="modal-subtitle">Vyber prompt podla nazvu a uprav jeho text.</p>
          </div>
          <button class="icon" type="button" @click="showPromptsModal = false">x</button>
        </header>

        <div class="batch-scroll">
          <div class="prompt-form">
            <label>
              <span>Nazov</span>
              <select v-model="selectedPromptName">
                <option value="">Vyber prompt</option>
                <option v-for="name in promptNames" :key="name" :value="name">{{ name }}</option>
                <option value="__new__">+ Novy prompt</option>
              </select>
            </label>

            <label v-if="selectedPromptName === '__new__'">
              <span>Novy nazov</span>
              <input v-model="newPromptName" placeholder="napr. summary_prompt" />
            </label>

            <label>
              <span>Prompt text</span>
              <textarea v-model="promptText" rows="15" placeholder="Sem vloz prompt..."></textarea>
            </label>

            <p v-if="promptsLoading">Nacitavam prompty...</p>
            <p v-if="promptsError" class="error">{{ promptsError }}</p>
          </div>
        </div>

        <div class="modal-actions">
          <button class="ghost" type="button" @click="showPromptsModal = false">Zatvorit</button>
          <button class="primary" type="button" :disabled="promptsSaving" @click="savePrompt">
            {{ promptsSaving ? 'Ukladam...' : 'Ulozit' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="showTranslationModal" class="modal-backdrop">
      <div class="modal modal-scroll">
        <header>
          <div>
            <p class="modal-kicker">Translations</p>
            <h2>{{ isEditMode ? 'Upravit preklad' : 'Pridat preklad' }}</h2>
          </div>
          <button class="icon" type="button" @click="showTranslationModal = false">x</button>
        </header>
        <form class="modal-form" @submit.prevent="isEditMode ? updateTranslation() : addTranslation()">
          <label>
            <span>Translation key</span>
            <input v-model="translationForm.translation_key" required />
          </label>
          <div class="translation-grid">
            <details v-for="(entry, index) in translationForm.translations" :key="`${entry.language_code}-${index}`"
              class="translation-dropdown">
              <summary class="translation-summary">
                {{ getLanguageLabel(entry.language_code) }}
              </summary>
              <div class="translation-panel">
                <label>
                  <span>Preklad</span>
                  <textarea v-model="entry.translated_text" rows="2" placeholder="Sem vlozte preklad"></textarea>
                </label>
              </div>
            </details>
          </div>
          <div class="modal-actions">
            <button class="ghost" type="button" @click="showTranslationModal = false">
              Zrusit
            </button>
            <button class="primary" type="submit">Ulozit</button>
          </div>
        </form>
      </div>
    </div>

    <div v-if="showLanguageModal" class="modal-backdrop">
      <div class="modal">
        <header>
          <div>
            <p class="modal-kicker">Languages</p>
            <h2>Pridat jazyk</h2>
          </div>
          <button class="icon" type="button" @click="showLanguageModal = false">x</button>
        </header>
        <form class="modal-form" @submit.prevent="addLanguage">
          <label>
            <span>Kod jazyka</span>
            <input v-model="languageForm.code" placeholder="sk" maxlength="5" required />
          </label>
          <label>
            <span>Nazov</span>
            <input v-model="languageForm.name" placeholder="Slovencina" required />
          </label>
          <label class="toggle">
            <input v-model="languageForm.is_active" type="checkbox" />
            <span>Aktivny jazyk</span>
          </label>
          <div class="modal-actions">
            <button class="ghost" type="button" @click="showLanguageModal = false">
              Zrusit
            </button>
            <button class="primary" type="submit" :disabled="isAddingLanguage">
              {{ isAddingLanguage ? 'Pridavam...' : 'Ulozit' }}
            </button>
          </div>
        </form>
      </div>
    </div>
    <div v-if="notifyMessage" class="notify-backdrop" @click.self="notifyMessage = ''">
      <div class="notify-card" :class="notifyType">
        <h3>{{ notifyType === 'success' ? 'Hotovo' : 'Upozornenie' }}</h3>
        <p>{{ notifyMessage }}</p>
        <button class="primary" type="button" @click="notifyMessage = ''">Zatvorit</button>
      </div>
    </div>
  </div>
</template>
<style src="../assets/dashboard.css"></style>
