<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { supabase } from '../lib/supabase'

const router = useRouter()
const email = ref('')
const password = ref('')
const isLoading = ref(false)
const errorMessage = ref('')

const signIn = async () => {
  errorMessage.value = ''
  isLoading.value = true
  try {
    const { error } = await supabase.auth.signInWithPassword({
      email: email.value.trim(),
      password: password.value,
    })

    if (error) {
      errorMessage.value = error.message
      return
    }

    await router.push('/dashboard')
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Unexpected error'
  } finally {
    isLoading.value = false
  }
}
</script>

<template>
  <div class="auth-shell">
    <div class="auth-panel">
      <header class="auth-header">
        <p class="auth-kicker">Admin</p>
        <h1>Prihlasenie</h1>
      </header>

      <form class="auth-form" @submit.prevent="signIn">
        <label class="field">
          <span>Email</span>
          <input v-model="email" type="email" placeholder="admin@example.sk" required />
        </label>
        <label class="field">
          <span>Heslo</span>
          <input v-model="password" type="password" placeholder="******" required />
        </label>

        <div class="form-row">
          <label class="checkbox">
            <input type="checkbox" />
            <span>Zapamatat si ma</span>
          </label>
          <button class="link" type="button">Zabudnute heslo?</button>
        </div>

        <button class="primary" type="submit" :disabled="isLoading">
          {{ isLoading ? 'Prihlasujem...' : 'Prihlasit sa' }}
        </button>

        <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
      </form>

    </div>
  </div>
</template>

<style scoped>
.auth-shell {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: var(--page-bg);
  color: var(--text-primary);
}

.auth-panel {
  width: min(420px, 100%);
  padding: 48px 40px;
  display: flex;
  flex-direction: column;
  gap: 32px;
  text-align: center;
  background: var(--panel-bg);
  box-shadow: 0 24px 60px rgba(15, 23, 42, 0.08);
  border-radius: 20px;
}

.auth-header h1 {
  font-size: 32px;
  margin: 8px 0 6px;
}

.auth-kicker {
  letter-spacing: 0.18em;
  text-transform: uppercase;
  font-size: 12px;
  color: var(--accent);
  font-weight: 600;
}

.auth-subtitle {
  color: var(--text-muted);
  font-size: 14px;
}

.auth-form {
  display: flex;
  flex-direction: column;
  gap: 18px;
  width: 100%;
  max-width: 320px;
  margin: 0 auto;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  color: var(--text-muted);
  text-align: left;
}

.field input {
  height: 44px;
  padding: 0 14px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: #fff;
  font-size: 15px;
  color: var(--text-primary);
}

.field input:focus {
  outline: 2px solid rgba(14, 116, 144, 0.2);
  border-color: var(--accent);
}

.form-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
}

.checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
}

.link {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 12px;
}

.primary {
  height: 46px;
  border-radius: 12px;
  border: none;
  background: var(--accent);
  color: #fff;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  box-shadow: 0 10px 30px rgba(14, 116, 144, 0.25);
}

.primary:disabled {
  opacity: 0.7;
  cursor: not-allowed;
  box-shadow: none;
}

.primary:not(:disabled):hover {
  transform: translateY(-1px);
}

.error {
  color: #b42318;
  font-size: 13px;
}

.auth-footer {
  color: var(--text-muted);
  font-size: 12px;
}
</style>
