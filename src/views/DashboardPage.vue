<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { supabase } from '../main'

type Row = {
  id: string
  translation_key?: string
  language_code?: string
  translated_text?: string
  category?: string | null
  last_updated?: string | null
  [key: string]: unknown
}

type Language = {
  code: string
  name: string
  is_active: boolean
  percent_translated?: number | null
}

const loggedIn = supabase.auth.getUser().then(({ data: { user } }) => user)
if (!loggedIn) {
  window.location.href = '/login'
}

const tableName = 'translations'

const rows = ref<Row[]>([])
const languages = ref<Language[]>([])
const isLoading = ref(false)
const errorMessage = ref('')
const search = ref('')

const showLanguageModal = ref(false)
const showTranslationModal = ref(false)
const showLanguageSelectModal = ref(true)

const selectedLanguageCodes = ref<string[]>([])

const perPagePreset = ref('25')
const customPerPage = ref(25)
const currentPage = ref(1)

const isEditMode = ref(false)
const editingId = ref<string | null>(null)

const selectedIds = ref<string[]>([])

const languageForm = ref({
  code: '',
  name: '',
  is_active: true,
})

const translationForm = ref({
  translation_key: '',
  language_code: '',
  translated_text: '',
  category: '',
})

const nameFilter = ref('')
const categoryFilter = ref('all')
const dateFrom = ref('')
const dateTo = ref('')

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

const categories = computed(() => {
  const unique = new Set<string>()
  rows.value.forEach((row) => {
    const value = String(row.category ?? '').trim()
    if (value) {
      unique.add(value)
    }
  })
  return Array.from(unique).sort((a, b) => a.localeCompare(b))
})

const visibleRows = computed(() => {
  if (!search.value.trim()) {
    return rows.value
  }
  const query = search.value.toLowerCase()
  return rows.value.filter((row) =>
    Object.values(row).some((value) => String(value ?? '').toLowerCase().includes(query))
  )
})

const filteredRows = computed(() => {
  const nameQuery = nameFilter.value.trim().toLowerCase()
  const categoryQuery = categoryFilter.value
  const from = dateFrom.value ? new Date(dateFrom.value) : null
  const to = dateTo.value ? new Date(dateTo.value) : null

  return visibleRows.value.filter((row) => {
    if (nameQuery) {
      const key = String(row.translation_key ?? '').toLowerCase()
      if (!key.includes(nameQuery)) {
        return false
      }
    }

    if (categoryQuery !== 'all') {
      const categoryValue = String(row.category ?? '')
      if (categoryValue !== categoryQuery) {
        return false
      }
    }

    if (from || to) {
      if (!row.last_updated) {
        return false
      }
      const rowDate = new Date(row.last_updated)
      if (from && rowDate < from) {
        return false
      }
      if (to) {
        const end = new Date(to)
        end.setHours(23, 59, 59, 999)
        if (rowDate > end) {
          return false
        }
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
  const first = rows.value[0]
  if (!first) {
    return []
  }
  return Object.keys(first).filter((column) => column !== 'id')
})

const allSelectedOnPage = computed(() => {
  if (!paginatedRows.value.length) {
    return false
  }
  return paginatedRows.value.every((row) => selectedIds.value.includes(row.id))
})

const loadRows = async () => {
  if (!selectedLanguageCodes.value.length) {
    rows.value = []
    return
  }
  isLoading.value = true
  errorMessage.value = ''
  const { data, error } = await supabase
    .from(tableName)
    .select('*')
    .in('language_code', selectedLanguageCodes.value)

  if (error) {
    errorMessage.value = error.message
    rows.value = []
  } else {
    rows.value = (data ?? []) as Row[]
  }

  isLoading.value = false
}

const loadLanguages = async () => {
  const { data } = await supabase
    .from('languages')
    .select('code, name, is_active, percent_translated')
    .order('name')
  languages.value = data ?? []
  if (!selectedLanguageCodes.value.length && languages.value.length) {
    selectedLanguageCodes.value = [languages.value[0]?.code || '']
  }
  if (!translationForm.value.language_code && languages.value.length && languages.value[0]) {
    translationForm.value.language_code = languages.value[0].code
  }
}

const toggleSelectAllLanguages = () => {
  if (allLanguagesSelected.value) {
    selectedLanguageCodes.value = []
    return
  }
  selectedLanguageCodes.value = languages.value.map((lang) => lang.code)
}

const confirmLanguageSelection = async () => {
  if (!selectedLanguageCodes.value.length) {
    return
  }
  showLanguageSelectModal.value = false
  if (!selectedLanguageCodes.value.includes(translationForm.value.language_code)) {
    translationForm.value.language_code = selectedLanguageCodes.value[0] || ''
  }
  await loadRows()
}

const resetLanguageForm = () => {
  languageForm.value = { code: '', name: '', is_active: true }
}

const resetTranslationForm = () => {
  translationForm.value = {
    translation_key: '',
    language_code: selectedLanguageCodes.value[0] || languages.value[0]?.code || '',
    translated_text: '',
    category: '',
  }
  isEditMode.value = false
  editingId.value = null
}

const resetFilters = () => {
  nameFilter.value = ''
  categoryFilter.value = 'all'
  dateFrom.value = ''
  dateTo.value = ''
}

const openAddTranslation = () => {
  resetTranslationForm()
  showTranslationModal.value = true
}

const openEditTranslation = (row: Row) => {
  translationForm.value = {
    translation_key: String(row.translation_key ?? ''),
    language_code: String(row.language_code ?? selectedLanguageCodes.value[0] ?? ''),
    translated_text: String(row.translated_text ?? ''),
    category: String(row.category ?? ''),
  }
  isEditMode.value = true
  editingId.value = row.id
  showTranslationModal.value = true
}

const addLanguage = async () => {
  errorMessage.value = ''
  const payload = {
    code: languageForm.value.code.trim(),
    name: languageForm.value.name.trim(),
    is_active: languageForm.value.is_active,
  }

  const { error } = await supabase.from('languages').insert(payload)
  if (error) {
    errorMessage.value = error.message
    return
  }

  await loadLanguages()
  resetLanguageForm()
  showLanguageModal.value = false
}

const addTranslation = async () => {
  errorMessage.value = ''
  const payload = {
    translation_key: translationForm.value.translation_key.trim(),
    language_code: translationForm.value.language_code,
    translated_text: translationForm.value.translated_text.trim(),
    category: translationForm.value.category.trim() || null,
  }

  const { error } = await supabase.from('translations').insert(payload)
  if (error) {
    errorMessage.value = error.message
    return
  }

  await loadRows()
  resetTranslationForm()
  showTranslationModal.value = false
}

const updateTranslation = async () => {
  if (!editingId.value) {
    return
  }
  errorMessage.value = ''
  const payload = {
    translation_key: translationForm.value.translation_key.trim(),
    language_code: translationForm.value.language_code,
    translated_text: translationForm.value.translated_text.trim(),
    category: translationForm.value.category.trim() || null,
  }

  const { error } = await supabase.from('translations').update(payload).eq('id', editingId.value)
  if (error) {
    errorMessage.value = error.message
    return
  }

  await loadRows()
  resetTranslationForm()
  showTranslationModal.value = false
}

const removeTranslations = async (ids: string[]) => {
  if (!ids.length) {
    return
  }
  const confirmed = window.confirm(`Naozaj chcete vymazat ${ids.length} zaznam(ov)?`)
  if (!confirmed) {
    return
  }
  errorMessage.value = ''
  const { error } = await supabase.from('translations').delete().in('id', ids)
  if (error) {
    errorMessage.value = error.message
    return
  }
  selectedIds.value = selectedIds.value.filter((id) => !ids.includes(id))
  await loadRows()
}

const toggleSelectRow = (id: string) => {
  if (selectedIds.value.includes(id)) {
    selectedIds.value = selectedIds.value.filter((selected) => selected !== id)
  } else {
    selectedIds.value = [...selectedIds.value, id]
  }
}

const toggleSelectAllOnPage = () => {
  if (allSelectedOnPage.value) {
    const pageIds = paginatedRows.value.map((row) => row.id)
    selectedIds.value = selectedIds.value.filter((id) => !pageIds.includes(id))
    return
  }
  const pageIds = paginatedRows.value.map((row) => row.id)
  const combined = new Set([...selectedIds.value, ...pageIds])
  selectedIds.value = Array.from(combined)
}

const goToPage = (page: number) => {
  const next = Math.min(Math.max(1, page), totalPages.value)
  currentPage.value = next
}

watch([visibleRows, perPage, nameFilter, categoryFilter, dateFrom, dateTo], () => {
  currentPage.value = 1
})

watch(totalPages, (pages) => {
  if (currentPage.value > pages) {
    currentPage.value = pages
  }
})

watch(selectedLanguageCodes, () => {
  selectedIds.value = []
  currentPage.value = 1
})

onMounted(async () => {
  await loadLanguages()
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
        <button class="primary" type="button" @click="openAddTranslation">Pridat preklad</button>
        <button class="ghost" type="button" @click="showLanguageModal = true">Pridat jazyk</button>
        <button
          v-if="selectedIds.length"
          class="ghost danger"
          type="button"
          @click="removeTranslations(selectedIds)"
        >
          Vymazat vybrane ({{ selectedIds.length }})
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
          <input
            v-if="perPagePreset === 'custom'"
            v-model.number="customPerPage"
            type="number"
            min="1"
            max="200"
            placeholder="napr. 50"
          />
        </div>
        <div class="pager">
          <button class="ghost" type="button" :disabled="currentPage === 1" @click="goToPage(1)">
            Prva
          </button>
          <button
            class="ghost"
            type="button"
            :disabled="currentPage === 1"
            @click="goToPage(currentPage - 1)"
          >
            Predchadzajuca
          </button>
          <span>Strana {{ currentPage }} / {{ totalPages }}</span>
          <button
            class="ghost"
            type="button"
            :disabled="currentPage === totalPages"
            @click="goToPage(currentPage + 1)"
          >
            Dalsia
          </button>
          <button
            class="ghost"
            type="button"
            :disabled="currentPage === totalPages"
            @click="goToPage(totalPages)"
          >
            Posledna
          </button>
        </div>
      </div>

      <div class="filter-bar">
        <label>
          <span>Nazov (key)</span>
          <input v-model="nameFilter" type="search" placeholder="napr. home.title" />
        </label>
        <label>
          <span>Kategoria</span>
          <select v-model="categoryFilter">
            <option value="all">Vsetky</option>
            <option v-for="category in categories" :key="category" :value="category">
              {{ category }}
            </option>
          </select>
        </label>
        <label>
          <span>Datum od</span>
          <input v-model="dateFrom" type="date" />
        </label>
        <label>
          <span>Datum do</span>
          <input v-model="dateTo" type="date" />
        </label>
        <button class="ghost" type="button" @click="resetFilters">Vymazat filtre</button>
      </div>

      <div class="table-wrap">
        <table v-if="columns.length" class="data-table">
          <thead>
            <tr>
              <th class="select-col">
                <input
                  type="checkbox"
                  :checked="allSelectedOnPage"
                  @change="toggleSelectAllOnPage"
                  aria-label="Select all"
                />
              </th>
              <th v-for="column in columns" :key="column">{{ column }}</th>
              <th class="actions-col"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in paginatedRows" :key="row.id" class="data-row">
              <td class="select-col">
                <input
                  type="checkbox"
                  :checked="selectedIds.includes(row.id)"
                  @change="toggleSelectRow(row.id)"
                  aria-label="Select row"
                />
              </td>
              <td v-for="column in columns" :key="column">
                {{ row[column] ?? '-' }}
              </td>
              <td class="actions-col">
                <div class="row-actions">
                  <button class="ghost" type="button" @click="openEditTranslation(row)">
                    Upravit
                  </button>
                  <button
                    class="ghost danger"
                    type="button"
                    @click="removeTranslations([row.id])"
                  >
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
            <input
              type="checkbox"
              :value="lang.code"
              v-model="selectedLanguageCodes"
            />
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
          <button
            class="primary"
            type="button"
            :disabled="!selectedLanguageCodes.length"
            @click="confirmLanguageSelection"
          >
            Pokracovat
          </button>
        </div>
      </div>
    </div>

    <div v-if="showTranslationModal" class="modal-backdrop">
      <div class="modal">
        <header>
          <div>
            <p class="modal-kicker">Translations</p>
            <h2>{{ isEditMode ? 'Upravit preklad' : 'Pridat preklad' }}</h2>
          </div>
          <button class="icon" type="button" @click="showTranslationModal = false">x</button>
        </header>
        <form
          class="modal-form"
          @submit.prevent="isEditMode ? updateTranslation() : addTranslation()"
        >
          <label>
            <span>Translation key</span>
            <input v-model="translationForm.translation_key" required />
          </label>
          <label>
            <span>Jazyk</span>
            <select v-model="translationForm.language_code" required>
              <option v-for="lang in languages" :key="lang.code" :value="lang.code">
                {{ lang.name }} ({{ lang.code }})
              </option>
            </select>
          </label>
          <label>
            <span>Prelozeny text</span>
            <textarea v-model="translationForm.translated_text" rows="4" required></textarea>
          </label>
          <label>
            <span>Kategoria</span>
            <input v-model="translationForm.category" placeholder="napr. onboarding" />
          </label>
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
            <button class="primary" type="submit">Ulozit</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
<style src="../assets/dashboard.css"></style>
