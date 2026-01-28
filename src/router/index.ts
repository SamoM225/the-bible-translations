import { createRouter, createWebHistory } from 'vue-router'
import LoginPage from '../views/LoginPage.vue'
import DashboardPage from '../views/DashboardPage.vue'
import { supabase } from '../lib/supabase'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'login', component: LoginPage, meta: { guestOnly: true } },
    { path: '/dashboard', name: 'dashboard', component: DashboardPage, meta: { requiresAuth: true } },
  ],
})

router.beforeEach(async (to) => {
  const { data } = await supabase.auth.getSession()
  const isAuthed = Boolean(data.session)

  if (to.meta.requiresAuth && !isAuthed) {
    return { name: 'login' }
  }

  if (to.meta.guestOnly && isAuthed) {
    return { name: 'dashboard' }
  }
})

export default router
