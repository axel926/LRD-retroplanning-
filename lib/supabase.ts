import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(url, key)

export type Project = {
  id: string
  name: string
  client: string
  color: string
  start_date: string
  end_date: string
}

export type Task = {
  id: string
  project_id: string
  name: string
  category: 'crea' | 'prod' | 'sourcing'
  subcategory: string | null
  color: string
  start_date: string
  end_date: string
  progress: number
}

export const CATEGORIES = {
  crea: { label: 'CRÉA', subs: ['mood', '3d', 'validations client'] },
  prod: { label: 'PROD', subs: ['atelier', 'logistique', 'montage', 'démontage'] },
  sourcing: { label: 'SOURCING', subs: [] },
} as const

export const PROJ_COLORS = [
  '#1E6B68','#2D6B8C','#6B8C2D','#8C6B2D',
  '#6B2D8C','#8C2D5A','#2D8C5A','#8C2D2D',
]

export const TASK_COLORS = [
  '#1E6B68','#2D6B8C','#6B8C2D','#8C6B2D',
  '#6B2D8C','#8C2D5A','#C4562A','#2D8C7A',
  '#7A4A2D','#2D4A7A','#7A2D6B','#4A7A2D',
]

export async function getProjects(): Promise<Project[]> {
  const { data } = await supabase.from('projects').select('*').order('created_at', { ascending: true })
  return data || []
}
export async function createProject(p: Omit<Project, 'id'>): Promise<Project> {
  const { data, error } = await supabase.from('projects').insert(p).select().single()
  if (error) throw error
  return data
}
export async function deleteProject(id: string) {
  await supabase.from('projects').delete().eq('id', id)
}
export async function getAllTasks(): Promise<Task[]> {
  const { data } = await supabase.from('tasks').select('*').order('start_date', { ascending: true })
  return data || []
}
export async function createTask(t: Omit<Task, 'id'>): Promise<Task> {
  const { data, error } = await supabase.from('tasks').insert(t).select().single()
  if (error) throw error
  return data
}
export async function updateTask(id: string, updates: Partial<Task>) {
  const { error } = await supabase.from('tasks').update(updates).eq('id', id)
  if (error) throw error
}
export async function deleteTask(id: string) {
  await supabase.from('tasks').delete().eq('id', id)
}
