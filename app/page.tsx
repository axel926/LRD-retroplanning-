'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  supabase, getProjects, createProject, deleteProject,
  getAllTasks, createTask, updateTask, deleteTask,
  CATEGORIES, PROJ_COLORS, TASK_COLORS,
  type Project, type Task,
} from '@/lib/supabase'

const MONTHS = ['JAN','FÉV','MAR','AVR','MAI','JUN','JUL','AOÛ','SEP','OCT','NOV','DÉC']
const MONTHS_FULL = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre']
const DAY_LETTERS = ['D','L','M','M','J','V','S']

function toIso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function parseDate(s: string) { return new Date(s + 'T00:00:00') }
function fmtShort(s: string) { const d = parseDate(s); return `${d.getDate()} ${MONTHS[d.getMonth()]}` }
function addDays(dateStr: string, n: number) { const d = parseDate(dateStr); d.setDate(d.getDate() + n); return toIso(d) }
function isWeekend(d: Date) { return d.getDay() === 0 || d.getDay() === 6 }
function startOfWeek(dateStr: string) { const d = parseDate(dateStr); const day = d.getDay(); const diff = (day === 0 ? -6 : 1 - day); d.setDate(d.getDate() + diff); return toIso(d) }
function getWeekNum(d: Date) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(),0,1))
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1)/7)
}

type ZoomLevel = 'day' | 'week' | 'month'
type View = 'gantt' | 'overview'

type Column = { label: string, sublabel?: string, key: string, start: Date, end: Date, isWeekend?: boolean, isToday?: boolean }

function getViewRange(zoom: ZoomLevel, anchor: Date): { start: Date, end: Date, columns: Column[] } {
  const today = toIso(new Date())

  if (zoom === 'day') {
    // Only weekdays — show 4 weeks of weekdays (20 days)
    const cols: Column[] = []
    // Find monday of current week
    const monday = parseDate(startOfWeek(toIso(anchor)))
    monday.setDate(monday.getDate() - 7) // start 1 week before
    let d = new Date(monday)
    while (cols.length < 25) {
      if (!isWeekend(d)) {
        const end = new Date(d); end.setDate(end.getDate() + 1)
        cols.push({
          label: DAY_LETTERS[d.getDay()],
          sublabel: `${d.getDate()} ${MONTHS[d.getMonth()]}`,
          key: toIso(d),
          start: new Date(d),
          end,
          isToday: toIso(d) === today,
        })
      }
      d.setDate(d.getDate() + 1)
    }
    return { start: cols[0].start, end: cols[cols.length-1].end, columns: cols }
  }

  if (zoom === 'week') {
    const cols: Column[] = []
    const startD = parseDate(startOfWeek(toIso(anchor)))
    startD.setDate(startD.getDate() - 7)
    for (let i = 0; i < 12; i++) {
      const d = new Date(startD); d.setDate(d.getDate() + i * 7)
      const end = new Date(d); end.setDate(end.getDate() + 7)
      cols.push({ label: `S${getWeekNum(d)}`, sublabel: `${d.getDate()} ${MONTHS[d.getMonth()]}`, key: toIso(d), start: d, end })
    }
    return { start: cols[0].start, end: cols[cols.length-1].end, columns: cols }
  }

  // month
  const cols: Column[] = []
  const start = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1)
  for (let i = 0; i < 6; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1)
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1)
    cols.push({ label: MONTHS[d.getMonth()], sublabel: String(d.getFullYear()), key: `${d.getFullYear()}-${d.getMonth()}`, start: d, end })
  }
  return { start: cols[0].start, end: cols[cols.length-1].end, columns: cols }
}

// For day zoom: map date to position ignoring weekends
function buildDayMap(columns: Column[]): Map<string, number> {
  const map = new Map<string, number>()
  columns.forEach((col, i) => { map.set(col.key, i) })
  return map
}

function snapDays(taskId: string, newStart: string, newEnd: string, allTasks: Task[], snapPx: number, dayWidthPx: number): { start: string; end: string } {
  const snapDayThreshold = Math.max(1, Math.round(snapPx / dayWidthPx))
  const dur = (parseDate(newEnd).getTime() - parseDate(newStart).getTime()) / 86400000
  let bestDelta = 0, bestDist = snapDayThreshold + 1
  for (const t of allTasks) {
    if (t.id === taskId) continue
    const d1 = (parseDate(t.end_date).getTime() - parseDate(newStart).getTime()) / 86400000
    if (Math.abs(d1) <= snapDayThreshold && Math.abs(d1) < bestDist) { bestDelta = d1; bestDist = Math.abs(d1) }
    const d2 = (parseDate(t.start_date).getTime() - parseDate(newEnd).getTime()) / 86400000
    if (Math.abs(d2) <= snapDayThreshold && Math.abs(d2) < bestDist) { bestDelta = d2; bestDist = Math.abs(d2) }
    const d3 = (parseDate(t.start_date).getTime() - parseDate(newStart).getTime()) / 86400000
    if (Math.abs(d3) <= snapDayThreshold && Math.abs(d3) < bestDist) { bestDelta = d3; bestDist = Math.abs(d3) }
  }
  if (bestDist <= snapDayThreshold) {
    const snappedStart = addDays(newStart, bestDelta)
    return { start: snappedStart, end: addDays(snappedStart, dur) }
  }
  return { start: newStart, end: newEnd }
}

export default function Home() {
  const [projects, setProjects] = useState<Project[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<View>('gantt')
  const [zoom, setZoom] = useState<ZoomLevel>('month')
  const [anchor, setAnchor] = useState(new Date())
  const [overviewYear, setOverviewYear] = useState(new Date().getFullYear())
  const [loading, setLoading] = useState(true)
  const [showProjModal, setShowProjModal] = useState(false)
  const [showTaskModal, setShowTaskModal] = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [snapIndicator, setSnapIndicator] = useState<string | null>(null)

  const [pName, setPName] = useState('')
  const [pClient, setPClient] = useState('')
  const [pColor, setPColor] = useState(PROJ_COLORS[0])
  const [pStart, setPStart] = useState(toIso(new Date()))
  const [pEnd, setPEnd] = useState(() => { const d = new Date(); d.setMonth(d.getMonth()+3); return toIso(d) })

  const [tProject, setTProject] = useState('')
  const [tCategory, setTCategory] = useState<keyof typeof CATEGORIES>('crea')
  const [tSub, setTSub] = useState('mood')
  const [tName, setTName] = useState('')
  const [tColor, setTColor] = useState(TASK_COLORS[0])
  const [tStart, setTStart] = useState(toIso(new Date()))
  const [tEnd, setTEnd] = useState(() => { const d = new Date(); d.setDate(d.getDate()+14); return toIso(d) })
  const [tProgress, setTProgress] = useState(0)

  const dragRef = useRef<{
    taskId: string, type: 'move'|'resize',
    startX: number, areaWidth: number,
    totalDays: number,
    origStart: string, origEnd: string, dur: number,
  } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [projs, tsks] = await Promise.all([getProjects(), getAllTasks()])
    setProjects(projs)
    setTasks(tsks)
    if (projs.length && !selectedId) setSelectedId(projs[0].id)
    setLoading(false)
  }, [selectedId])

  useEffect(() => { load() }, [])

  useEffect(() => {
    const ch = supabase.channel('lrd-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [load])

  const { start: viewStart, end: viewEnd, columns } = getViewRange(zoom, anchor)
  const totalDays = (viewEnd.getTime() - viewStart.getTime()) / 86400000

  // For day zoom, use column-based positioning
  const dayMap = zoom === 'day' ? buildDayMap(columns) : null

  function pctFromDate(dateStr: string): number {
    if (zoom === 'day' && dayMap) {
      // Find nearest weekday
      let d = parseDate(dateStr)
      let attempts = 0
      while (isWeekend(d) && attempts < 7) { d.setDate(d.getDate() + 1); attempts++ }
      const key = toIso(d)
      const idx = dayMap.get(key)
      if (idx === undefined) {
        // Before or after range
        if (d < columns[0].start) return 0
        return 100
      }
      return (idx / columns.length) * 100
    }
    return ((parseDate(dateStr).getTime() - viewStart.getTime()) / 86400000 / totalDays) * 100
  }

  function pctWidth(s: string, e: string): number {
    if (zoom === 'day' && dayMap) {
      // Count weekdays between s and e
      let d = parseDate(s)
      const endD = parseDate(e)
      let count = 0
      while (d < endD) {
        if (!isWeekend(d)) count++
        d.setDate(d.getDate() + 1)
      }
      return (count / columns.length) * 100
    }
    return ((parseDate(e).getTime() - parseDate(s).getTime()) / 86400000 / totalDays) * 100
  }

  function shiftAnchor(dir: number) {
    const d = new Date(anchor)
    if (zoom === 'day') d.setDate(d.getDate() + dir * 5)
    else if (zoom === 'week') d.setDate(d.getDate() + dir * 28)
    else d.setMonth(d.getMonth() + dir * 3)
    setAnchor(d)
  }

  function onMouseDownBar(e: React.MouseEvent, taskId: string, isResize: boolean) {
    if (isResize) e.stopPropagation()
    e.preventDefault()
    const barsArea = (e.currentTarget as HTMLElement).closest('.bars-area') as HTMLElement
    const rect = barsArea.getBoundingClientRect()
    const task = tasks.find(t => t.id === taskId)!
    const dur = (parseDate(task.end_date).getTime() - parseDate(task.start_date).getTime()) / 86400000
    dragRef.current = {
      taskId, type: isResize ? 'resize' : 'move',
      startX: e.clientX, areaWidth: rect.width,
      totalDays, origStart: task.start_date, origEnd: task.end_date, dur,
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  function onMouseMove(e: MouseEvent) {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    const rawDays = Math.round((dx / d.areaWidth) * d.totalDays)
    const dayWidthPx = d.areaWidth / d.totalDays
    const SNAP_PX = 10

    setTasks(prev => prev.map(t => {
      if (t.id !== d.taskId) return t
      if (d.type === 'move') {
        const rawStart = addDays(d.origStart, rawDays)
        const rawEnd = addDays(d.origEnd, rawDays)
        const snapped = snapDays(t.id, rawStart, rawEnd, prev, SNAP_PX, dayWidthPx)
        setSnapIndicator(snapped.start !== rawStart ? t.id : null)
        return { ...t, start_date: snapped.start, end_date: snapped.end }
      } else {
        const rawEnd = addDays(d.origEnd, rawDays)
        const snapped = snapDays(t.id, t.start_date, rawEnd, prev, SNAP_PX, dayWidthPx)
        if (parseDate(snapped.end) > parseDate(t.start_date)) return { ...t, end_date: snapped.end }
        return t
      }
    }))
  }

  async function onMouseUp() {
    const d = dragRef.current
    dragRef.current = null
    setSnapIndicator(null)
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
    if (!d) return
    const task = tasks.find(t => t.id === d.taskId)
    if (task) await updateTask(task.id, { start_date: task.start_date, end_date: task.end_date })
  }

  async function handleCreateProject() {
    if (!pName.trim()) return
    const proj = await createProject({ name: pName.toUpperCase(), client: pClient, color: pColor, start_date: pStart, end_date: pEnd })
    setProjects(prev => [...prev, proj])
    setSelectedId(proj.id)
    setShowProjModal(false)
    setPName(''); setPClient('')
  }

  async function handleDeleteProject(id: string) {
    if (!confirm('Supprimer ce projet et toutes ses tâches ?')) return
    await deleteProject(id)
    setProjects(prev => prev.filter(p => p.id !== id))
    setTasks(prev => prev.filter(t => t.project_id !== id))
    if (selectedId === id) setSelectedId(projects.find(p => p.id !== id)?.id || null)
  }

  function openNewTask(projectId?: string) {
    setEditingTask(null)
    setTProject(projectId || selectedId || projects[0]?.id || '')
    setTCategory('crea'); setTSub('mood'); setTName('')
    setTColor(TASK_COLORS[0])
    setTStart(toIso(new Date()))
    const d2 = new Date(); d2.setDate(d2.getDate()+14); setTEnd(toIso(d2))
    setTProgress(0)
    setShowTaskModal(true)
  }

  function openEditTask(task: Task) {
    setEditingTask(task)
    setTProject(task.project_id)
    setTCategory(task.category as keyof typeof CATEGORIES)
    setTSub(task.subcategory || '')
    setTName(task.name)
    setTColor(task.color || TASK_COLORS[0])
    setTStart(task.start_date)
    setTEnd(task.end_date)
    setTProgress(task.progress)
    setShowTaskModal(true)
  }

  async function handleSaveTask() {
    const catDef = CATEGORIES[tCategory]
    const payload = {
      project_id: tProject,
      name: tName || (tSub || catDef.label),
      category: tCategory,
      subcategory: tSub || null,
      color: tColor,
      start_date: tStart,
      end_date: tEnd,
      progress: tProgress,
    }
    if (editingTask) {
      await updateTask(editingTask.id, payload)
      setTasks(prev => prev.map(t => t.id === editingTask.id ? { ...t, ...payload } : t))
    } else {
      const t = await createTask(payload)
      setTasks(prev => [...prev, t])
    }
    setShowTaskModal(false)
    setSelectedId(tProject)
  }

  async function handleDeleteTask() {
    if (!editingTask) return
    await deleteTask(editingTask.id)
    setTasks(prev => prev.filter(t => t.id !== editingTask.id))
    setShowTaskModal(false)
  }

  const selectedProject = projects.find(p => p.id === selectedId)
  const projTasks = tasks.filter(t => t.project_id === selectedId)
  const todayPct = pctFromDate(toIso(new Date()))
  const catSubs = CATEGORIES[tCategory].subs

  const anchorLabel = zoom === 'day'
    ? `${columns[0]?.sublabel} — ${columns[columns.length-1]?.sublabel}`
    : zoom === 'week'
    ? `S${getWeekNum(columns[0]?.start || new Date())} — S${getWeekNum(columns[columns.length-1]?.start || new Date())}`
    : `${MONTHS_FULL[columns[0]?.start.getMonth()]} — ${MONTHS_FULL[columns[columns.length-1]?.start.getMonth()]} ${columns[columns.length-1]?.start.getFullYear()}`

  // Week sub-header for day zoom: group by week
  const weekGroups: {label: string, count: number}[] = []
  if (zoom === 'day') {
    let lastWeek = -1
    columns.forEach(col => {
      const wn = getWeekNum(col.start)
      if (wn !== lastWeek) {
        weekGroups.push({ label: `S${wn} · ${MONTHS[col.start.getMonth()]} ${col.start.getFullYear()}`, count: 1 })
        lastWeek = wn
      } else {
        weekGroups[weekGroups.length-1].count++
      }
    })
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', overflow:'hidden' }}>
      {/* TOPBAR */}
      <div style={{ background:'#144947', borderBottom:'1px solid rgba(0,0,0,0.2)', padding:'0 24px', height:54, display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0, zIndex:100 }}>
        <div style={{ fontFamily:'var(--font-display)', fontSize:21, letterSpacing:'0.12em', color:'white' }}>
          LA RÉPONSE D. <span style={{ color:'#9DD4D1' }}>·</span> RÉTRO
        </div>
        <div style={{ display:'flex', gap:8 }}>
          {projects.length > 0 && <button onClick={() => openNewTask()} style={btnStyle('ghost')}>+ TÂCHE</button>}
          <button onClick={() => setShowProjModal(true)} style={btnStyle('primary')}>+ PROJET</button>
        </div>
      </div>

      <div style={{ display:'flex', flex:1, overflow:'hidden' }}>
        {/* SIDEBAR */}
        <div style={{ width:230, flexShrink:0, background:'#144947', borderRight:'1px solid rgba(0,0,0,0.15)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
          <div style={{ padding:'16px 14px 10px', borderBottom:'1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ fontFamily:'var(--font-display)', fontSize:11, letterSpacing:'0.2em', color:'#9DD4D1', marginBottom:10 }}>PROJETS EN COURS</div>
          </div>
          <div style={{ flex:1, overflowY:'auto', padding:'8px' }}>
            {loading && <div style={{ color:'rgba(255,255,255,0.4)', fontSize:11, padding:'8px 4px' }}>Chargement…</div>}
            {projects.map(p => {
              const pt = tasks.filter(t => t.project_id === p.id)
              const avg = pt.length ? Math.round(pt.reduce((a,t)=>a+t.progress,0)/pt.length) : 0
              const active = p.id === selectedId
              return (
                <div key={p.id} onClick={() => setSelectedId(p.id)} style={{ padding:'10px', borderRadius:3, cursor:'pointer', marginBottom:3, border:`1.5px solid ${active?'#9DD4D1':'transparent'}`, background:active?'rgba(255,255,255,0.1)':'transparent', transition:'all 0.12s' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <div style={{ width:8,height:8,borderRadius:'50%',background:p.color,flexShrink:0 }}/>
                    <span style={{ fontWeight:500, fontSize:12, color:'white', flex:1 }}>{p.name}</span>
                    <span onClick={e=>{e.stopPropagation();handleDeleteProject(p.id)}} style={{ color:'rgba(255,255,255,0.25)', fontSize:12, cursor:'pointer' }}>✕</span>
                  </div>
                  <div style={{ fontSize:10, color:'rgba(255,255,255,0.45)', marginTop:3, paddingLeft:16 }}>{p.client} · {avg}%</div>
                  <div style={{ height:2, background:'rgba(255,255,255,0.1)', borderRadius:1, marginTop:6 }}>
                    <div style={{ height:'100%', width:`${avg}%`, background:p.color, borderRadius:1 }}/>
                  </div>
                </div>
              )
            })}
          </div>
          <div style={{ display:'flex', borderTop:'1px solid rgba(255,255,255,0.08)', flexShrink:0 }}>
            {(['gantt','overview'] as View[]).map(v => (
              <div key={v} onClick={() => setView(v)} style={{ flex:1, textAlign:'center', padding:'11px 0', fontFamily:'var(--font-display)', fontSize:12, letterSpacing:'0.1em', cursor:'pointer', color:view===v?'white':'rgba(255,255,255,0.4)', borderTop:`2px solid ${view===v?'#9DD4D1':'transparent'}`, transition:'all 0.15s' }}>
                {v === 'gantt' ? 'GANTT' : 'ANNUEL'}
              </div>
            ))}
          </div>
        </div>

        {/* MAIN */}
        <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:'#7BBFBC' }}>
          {view === 'gantt' ? (
            <>
              {/* TOOLBAR */}
              <div style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 22px', background:'#5A9E9B', borderBottom:'1px solid rgba(0,0,0,0.12)', flexShrink:0 }}>
                <div style={{ fontFamily:'var(--font-display)', fontSize:22, letterSpacing:'0.08em', color:'white', flex:1 }}>
                  {selectedProject ? selectedProject.name : 'SÉLECTIONNER UN PROJET'}
                </div>
                {/* ZOOM */}
                <div style={{ display:'flex', borderRadius:2, overflow:'hidden', border:'1px solid rgba(255,255,255,0.2)' }}>
                  {(['day','week','month'] as ZoomLevel[]).map(z => (
                    <button key={z} onClick={()=>setZoom(z)} style={{ padding:'5px 12px', background:zoom===z?'white':'transparent', color:zoom===z?'#144947':'white', border:'none', cursor:'pointer', fontFamily:'var(--font-display)', fontSize:12, letterSpacing:'0.08em', borderLeft:z!=='day'?'1px solid rgba(255,255,255,0.2)':'none' }}>
                      {z === 'day' ? 'JOUR' : z === 'week' ? 'SEMAINE' : 'MOIS'}
                    </button>
                  ))}
                </div>
                {/* NAV */}
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <button onClick={()=>shiftAnchor(-1)} style={navBtnStyle}>‹</button>
                  <div style={{ fontFamily:'var(--font-display)', fontSize:11, letterSpacing:'0.08em', minWidth:170, textAlign:'center', color:'white' }}>{anchorLabel}</div>
                  <button onClick={()=>shiftAnchor(1)} style={navBtnStyle}>›</button>
                  <button onClick={()=>setAnchor(new Date())} style={{ ...navBtnStyle, fontSize:10, width:'auto', padding:'0 10px', fontFamily:'var(--font-display)' }}>AUJOURD'HUI</button>
                </div>
                {selectedProject && <button onClick={() => openNewTask(selectedId!)} style={btnStyle('primary')}>+ TÂCHE</button>}
              </div>

              {/* GANTT */}
              <div style={{ flex:1, overflowY:'auto', overflowX:'auto', position:'relative' }}>
                <div style={{ minWidth: zoom==='day'?columns.length*44+200:900, display:'flex', flexDirection:'column' }}>

                  {/* WEEK GROUP HEADER (day zoom only) */}
                  {zoom === 'day' && (
                    <div style={{ display:'flex', position:'sticky', top:0, zIndex:11, background:'#4A8E8B', borderBottom:'1px solid rgba(0,0,0,0.1)' }}>
                      <div style={{ width:200, flexShrink:0, borderRight:'1px solid rgba(0,0,0,0.1)' }}/>
                      <div style={{ flex:1, display:'flex' }}>
                        {weekGroups.map((wg, i) => (
                          <div key={i} style={{ width:`${(wg.count/columns.length)*100}%`, height:20, display:'flex', alignItems:'center', paddingLeft:8, fontFamily:'var(--font-display)', fontSize:9, letterSpacing:'0.12em', color:'rgba(255,255,255,0.5)', borderLeft:i>0?'1px solid rgba(0,0,0,0.1)':'none', whiteSpace:'nowrap', overflow:'hidden' }}>
                            {wg.label}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* COLUMN HEADER */}
                  <div style={{ display:'flex', position:'sticky', top: zoom==='day'?20:0, zIndex:10, background:'#5A9E9B', borderBottom:'1px solid rgba(0,0,0,0.12)' }}>
                    <div style={{ width:200, flexShrink:0, borderRight:'1px solid rgba(0,0,0,0.12)' }}>
                      <div style={{ height:zoom==='day'?32:36, display:'flex', alignItems:'center', padding:'0 16px', fontFamily:'var(--font-display)', fontSize:10, letterSpacing:'0.18em', color:'rgba(255,255,255,0.5)' }}>TÂCHE</div>
                    </div>
                    <div style={{ flex:1, display:'flex' }}>
                      {columns.map((col, i) => (
                        <div key={col.key} style={{ flex:1, height:zoom==='day'?32:36, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', fontFamily:'var(--font-display)', fontSize:zoom==='day'?13:11, letterSpacing:'0.08em', color: col.isToday?'white':'rgba(255,255,255,0.65)', borderLeft:i>0?'1px solid rgba(0,0,0,0.1)':'none', background: col.isToday?'rgba(255,255,255,0.18)':'transparent', whiteSpace:'nowrap' }}>
                          <span style={{ fontWeight: col.isToday?700:400 }}>{col.label}</span>
                          {zoom !== 'day' && col.sublabel && <span style={{ fontSize:9, opacity:0.5, marginTop:1 }}>{col.sublabel}</span>}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* ROWS */}
                  {!selectedProject ? (
                    <div style={{ padding:'60px 0', textAlign:'center', color:'rgba(255,255,255,0.4)' }}>
                      <div style={{ fontFamily:'var(--font-display)', fontSize:20, letterSpacing:'0.1em' }}>AUCUN PROJET SÉLECTIONNÉ</div>
                    </div>
                  ) : projTasks.length === 0 ? (
                    <div style={{ padding:'60px 0', textAlign:'center', color:'rgba(255,255,255,0.4)' }}>
                      <div style={{ fontFamily:'var(--font-display)', fontSize:20, letterSpacing:'0.1em', marginBottom:12 }}>AUCUNE TÂCHE</div>
                      <button onClick={() => openNewTask(selectedId!)} style={btnStyle('primary')}>+ AJOUTER UNE TÂCHE</button>
                    </div>
                  ) : (
                    projTasks.map(task => {
                      const l = Math.max(0, pctFromDate(task.start_date))
                      const w = Math.max(0.5, pctWidth(task.start_date, task.end_date))
                      const isSnapping = snapIndicator === task.id
                      const label = task.subcategory ? task.subcategory.toUpperCase() : CATEGORIES[task.category as keyof typeof CATEGORIES]?.label || task.category
                      return (
                        <div key={task.id} style={{ display:'flex', borderBottom:'1px solid rgba(0,0,0,0.08)', minHeight:50 }}>
                          <div onClick={() => openEditTask(task)} style={{ width:200, flexShrink:0, borderRight:'1px solid rgba(0,0,0,0.08)', padding:'8px 16px', display:'flex', flexDirection:'column', justifyContent:'center', background:'rgba(255,255,255,0.06)', cursor:'pointer', position:'sticky', left:0, zIndex:5 }}
                            onMouseEnter={e=>(e.currentTarget.style.background='rgba(255,255,255,0.12)')}
                            onMouseLeave={e=>(e.currentTarget.style.background='rgba(255,255,255,0.06)')}
                          >
                            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                              <div style={{ width:6,height:6,borderRadius:'50%',background:task.color,flexShrink:0 }}/>
                              <div style={{ fontWeight:500, fontSize:12, color:'white' }}>{label}</div>
                            </div>
                            {task.name && task.name !== task.subcategory && (
                              <div style={{ fontSize:10, color:'rgba(255,255,255,0.5)', marginTop:2, paddingLeft:12 }}>{task.name}</div>
                            )}
                            <div style={{ fontSize:10, color:'rgba(255,255,255,0.4)', marginTop:2, paddingLeft:12 }}>
                              {fmtShort(task.start_date)} → {fmtShort(task.end_date)}
                            </div>
                          </div>

                          <div className="bars-area" style={{ flex:1, position:'relative', display:'flex', alignItems:'center' }}>
                            {columns.map((col, i) => (
                              <div key={col.key} style={{ position:'absolute', top:0, bottom:0, left:`${(i/columns.length)*100}%`, width:`${100/columns.length}%`, background: col.isToday?'rgba(255,255,255,0.08)':'transparent', borderLeft:i>0?'1px solid rgba(0,0,0,0.07)':'none', pointerEvents:'none' }}/>
                            ))}
                            {todayPct>=0&&todayPct<=100&&(
                              <div style={{ position:'absolute',top:0,bottom:0,left:`${todayPct}%`,width:2,background:'rgba(255,255,255,0.7)',zIndex:4,pointerEvents:'none' }}/>
                            )}
                            <div
                              onMouseDown={e => onMouseDownBar(e, task.id, false)}
                              style={{ position:'absolute', height:28, left:`${l}%`, width:`${w}%`, minWidth:6, background:task.color, borderRadius:2, cursor:'grab', display:'flex', alignItems:'center', padding:'0 10px', fontSize:10, fontWeight:500, color:'white', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', userSelect:'none', zIndex:2, textShadow:'0 1px 2px rgba(0,0,0,0.3)', outline:isSnapping?'2px solid white':'none' }}
                            >
                              <div style={{ position:'absolute',left:0,top:0,bottom:0,width:`${task.progress}%`,background:'rgba(0,0,0,0.2)',borderRadius:'2px 0 0 2px',pointerEvents:'none' }}/>
                              <span style={{ position:'relative',zIndex:1 }}>{label}{task.name&&task.name!==task.subcategory?` · ${task.name}`:''}</span>
                              <div onMouseDown={e=>onMouseDownBar(e,task.id,true)} style={{ position:'absolute',right:0,top:0,bottom:0,width:8,cursor:'col-resize',background:'rgba(0,0,0,0.2)',borderRadius:'0 2px 2px 0' }}/>
                            </div>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            </>
          ) : (
            <OverviewPanel projects={projects} tasks={tasks} year={overviewYear} onYearChange={setOverviewYear} onSelectProject={id=>{setSelectedId(id);setView('gantt')}} />
          )}
        </div>
      </div>

      {showProjModal && (
        <Modal onClose={() => setShowProjModal(false)} title="NOUVEAU PROJET">
          <FormRow label="NOM DU PROJET"><input type="text" value={pName} onChange={e=>setPName(e.target.value)} placeholder="ex. SALON M&O 2025" autoFocus/></FormRow>
          <FormRow label="CLIENT"><input type="text" value={pClient} onChange={e=>setPClient(e.target.value)} placeholder="ex. Valentino"/></FormRow>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:14 }}>
            <FormRow label="DÉBUT"><input type="date" value={pStart} onChange={e=>setPStart(e.target.value)}/></FormRow>
            <FormRow label="FIN"><input type="date" value={pEnd} onChange={e=>setPEnd(e.target.value)}/></FormRow>
          </div>
          <FormRow label="COULEUR DU PROJET"><ColorPicker colors={PROJ_COLORS} selected={pColor} onSelect={setPColor}/></FormRow>
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:22 }}>
            <button onClick={()=>setShowProjModal(false)} style={btnStyle('ghost')}>Annuler</button>
            <button onClick={handleCreateProject} style={btnStyle('primary')}>CRÉER LE PROJET</button>
          </div>
        </Modal>
      )}

      {showTaskModal && (
        <Modal onClose={() => setShowTaskModal(false)} title={editingTask ? 'MODIFIER LA TÂCHE' : 'NOUVELLE TÂCHE'}>
          <FormRow label="PROJET">
            <select value={tProject} onChange={e=>setTProject(e.target.value)}>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </FormRow>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:14 }}>
            <FormRow label="CATÉGORIE">
              <select value={tCategory} onChange={e=>{ const v=e.target.value as keyof typeof CATEGORIES; setTCategory(v); setTSub(CATEGORIES[v].subs[0]||'') }}>
                <option value="crea">CRÉA</option>
                <option value="prod">PROD</option>
                <option value="sourcing">SOURCING</option>
              </select>
            </FormRow>
            {catSubs.length > 0 && (
              <FormRow label="SOUS-CATÉGORIE">
                <select value={tSub} onChange={e=>setTSub(e.target.value)}>
                  {catSubs.map(s => <option key={s} value={s}>{s.toUpperCase()}</option>)}
                </select>
              </FormRow>
            )}
          </div>
          <FormRow label="PRÉCISION (optionnel)">
            <input type="text" value={tName} onChange={e=>setTName(e.target.value)} placeholder="ex. Planches ambiance, Atelier bois…"/>
          </FormRow>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:14 }}>
            <FormRow label="DÉBUT"><input type="date" value={tStart} onChange={e=>setTStart(e.target.value)}/></FormRow>
            <FormRow label="FIN"><input type="date" value={tEnd} onChange={e=>setTEnd(e.target.value)}/></FormRow>
          </div>
          <FormRow label="COULEUR DU BLOC"><ColorPicker colors={TASK_COLORS} selected={tColor} onSelect={setTColor}/></FormRow>
          <FormRow label={`AVANCEMENT · ${tProgress}%`}>
            <input type="range" min={0} max={100} value={tProgress} onChange={e=>setTProgress(Number(e.target.value))} style={{ width:'100%', accentColor:'#9DD4D1', cursor:'pointer' }}/>
          </FormRow>
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:22 }}>
            {editingTask && <button onClick={handleDeleteTask} style={{ ...btnStyle('ghost'), marginRight:'auto', color:'#ff8080', borderColor:'rgba(255,100,100,0.3)' }}>SUPPRIMER</button>}
            <button onClick={()=>setShowTaskModal(false)} style={btnStyle('ghost')}>Annuler</button>
            <button onClick={handleSaveTask} style={btnStyle('primary')}>ENREGISTRER</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function ColorPicker({ colors, selected, onSelect }: { colors: string[], selected: string, onSelect: (c:string)=>void }) {
  return (
    <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginTop:4 }}>
      {colors.map(c => (
        <div key={c} onClick={()=>onSelect(c)} style={{ width:24, height:24, borderRadius:'50%', background:c, cursor:'pointer', border:`2.5px solid ${c===selected?'white':'transparent'}`, transition:'transform 0.15s' }}
          onMouseEnter={e=>(e.currentTarget.style.transform='scale(1.2)')}
          onMouseLeave={e=>(e.currentTarget.style.transform='scale(1)')}
        />
      ))}
    </div>
  )
}

function OverviewPanel({ projects, tasks, year, onYearChange, onSelectProject }:{
  projects: Project[], tasks: Task[], year: number,
  onYearChange:(y:number)=>void, onSelectProject:(id:string)=>void
}) {
  const yS = new Date(year, 0, 1)
  const yE = new Date(year, 11, 31)
  const total = (yE.getTime() - yS.getTime()) / 86400000 + 1
  const pct = (d:string) => Math.max(0, Math.min(100, ((new Date(d+'T00:00:00').getTime()-yS.getTime())/86400000/total)*100))
  const todayPct = new Date().getFullYear()===year ? pct(toIso(new Date())) : -1
  const MS = ['JAN','FÉV','MAR','AVR','MAI','JUN','JUL','AOÛ','SEP','OCT','NOV','DÉC']

  return (
    <div style={{ flex:1, overflowY:'auto', padding:28 }}>
      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:24 }}>
        <button onClick={()=>onYearChange(year-1)} style={navBtnStyle}>‹</button>
        <div style={{ fontFamily:'var(--font-display)', fontSize:32, letterSpacing:'0.06em', color:'white' }}>VUE <span style={{color:'#144947'}}>{year}</span></div>
        <button onClick={()=>onYearChange(year+1)} style={navBtnStyle}>›</button>
      </div>
      <div style={{ display:'flex', paddingLeft:180, marginBottom:8 }}>
        {MS.map(m => <div key={m} style={{ flex:1, fontFamily:'var(--font-display)', fontSize:10, letterSpacing:'0.12em', color:'rgba(255,255,255,0.5)', textAlign:'center' }}>{m}</div>)}
      </div>
      {projects.map(proj => {
        const pt = tasks.filter(t => t.project_id === proj.id)
        return (
          <div key={proj.id} style={{ marginBottom:24 }}>
            <div onClick={()=>onSelectProject(proj.id)} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8, cursor:'pointer' }}>
              <div style={{ width:8,height:8,borderRadius:'50%',background:proj.color,flexShrink:0 }}/>
              <span style={{ fontFamily:'var(--font-display)', fontSize:15, letterSpacing:'0.1em', color:'white' }}>{proj.name}</span>
              <span style={{ fontSize:10, color:'rgba(255,255,255,0.4)' }}>{proj.client}</span>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
              <div style={{ width:170, flexShrink:0 }}/>
              <div style={{ flex:1, height:20, borderRadius:2, background:'rgba(0,0,0,0.15)', position:'relative' }}>
                {todayPct>=0&&<div style={{ position:'absolute',top:0,bottom:0,left:`${todayPct}%`,width:2,background:'rgba(255,255,255,0.6)',zIndex:3 }}/>}
                {pt.map(t => { const l=pct(t.start_date),w=Math.max(0.3,pct(t.end_date)-l); return <div key={t.id} style={{ position:'absolute',height:'100%',left:`${l}%`,width:`${w}%`,background:proj.color,opacity:0.7,borderRadius:2 }}/> })}
              </div>
            </div>
            {pt.map(t => {
              const l=pct(t.start_date),w=Math.max(0.3,pct(t.end_date)-l)
              const label = t.subcategory ? t.subcategory.toUpperCase() : CATEGORIES[t.category as keyof typeof CATEGORIES]?.label || t.category
              return (
                <div key={t.id} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:4 }}>
                  <div style={{ width:170, flexShrink:0, fontSize:10, color:'rgba(255,255,255,0.5)', paddingLeft:16, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{label}{t.name&&t.name!==t.subcategory?` · ${t.name}`:''}</div>
                  <div style={{ flex:1, height:14, borderRadius:2, background:'rgba(0,0,0,0.12)', position:'relative' }}>
                    {todayPct>=0&&<div style={{ position:'absolute',top:0,bottom:0,left:`${todayPct}%`,width:1.5,background:'rgba(255,255,255,0.5)',zIndex:3 }}/>}
                    <div style={{ position:'absolute',height:'100%',left:`${l}%`,width:`${w}%`,background:proj.color,opacity:0.85,borderRadius:2 }}/>
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function Modal({ onClose, title, children }:{ onClose:()=>void, title:string, children:React.ReactNode }) {
  return (
    <div onClick={e=>{if(e.target===e.currentTarget)onClose()}} style={{ position:'fixed',inset:0,background:'rgba(14,45,44,0.7)',zIndex:200,display:'flex',alignItems:'center',justifyContent:'center' }}>
      <div style={{ background:'#144947',border:'1px solid #1E6B68',borderRadius:4,width:460,maxWidth:'95vw',padding:28,position:'relative',maxHeight:'90vh',overflowY:'auto' }}>
        <button onClick={onClose} style={{ position:'absolute',top:14,right:14,background:'none',border:'none',color:'rgba(255,255,255,0.35)',fontSize:18,cursor:'pointer' }}>✕</button>
        <div style={{ fontFamily:'var(--font-display)',fontSize:22,letterSpacing:'0.1em',color:'white',marginBottom:22 }}>{title}</div>
        {children}
      </div>
    </div>
  )
}

function FormRow({ label, children }:{ label:string, children:React.ReactNode }) {
  return (
    <div style={{ marginBottom:14 }}>
      <label style={{ display:'block',fontFamily:'var(--font-display)',fontSize:10,letterSpacing:'0.18em',color:'#9DD4D1',marginBottom:6 }}>{label}</label>
      {children}
    </div>
  )
}

function btnStyle(type:'primary'|'ghost'): React.CSSProperties {
  return { fontFamily:'var(--font-display)', fontSize:13, padding:'6px 16px', borderRadius:2, border:type==='ghost'?'1.5px solid rgba(255,255,255,0.25)':'none', background:type==='primary'?'white':'transparent', color:type==='primary'?'#144947':'white', cursor:'pointer', letterSpacing:'0.08em' }
}

const navBtnStyle: React.CSSProperties = { width:30, height:30, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(255,255,255,0.1)', border:'1px solid rgba(255,255,255,0.2)', borderRadius:2, cursor:'pointer', fontSize:16, color:'white' }
