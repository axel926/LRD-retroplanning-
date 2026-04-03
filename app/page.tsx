'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  supabase, getProjects, createProject, deleteProject,
  getAllTasks, createTask, updateTask, deleteTask,
  BLOCK_LIBRARY, PROJ_COLORS, TASK_COLORS,
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
type Column = { label: string, sublabel?: string, key: string, start: Date, end: Date, isToday?: boolean }

function getViewRange(zoom: ZoomLevel, anchor: Date): { start: Date, end: Date, columns: Column[] } {
  const today = toIso(new Date())
  if (zoom === 'day') {
    const cols: Column[] = []
    const monday = parseDate(startOfWeek(toIso(anchor)))
    monday.setDate(monday.getDate() - 7)
    let d = new Date(monday)
    while (cols.length < 25) {
      if (!isWeekend(d)) {
        const end = new Date(d); end.setDate(end.getDate() + 1)
        cols.push({ label: DAY_LETTERS[d.getDay()], sublabel: `${d.getDate()} ${MONTHS[d.getMonth()]}`, key: toIso(d), start: new Date(d), end, isToday: toIso(d) === today })
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
  const cols: Column[] = []
  const start = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1)
  for (let i = 0; i < 6; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1)
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1)
    cols.push({ label: MONTHS[d.getMonth()], sublabel: String(d.getFullYear()), key: `${d.getFullYear()}-${d.getMonth()}`, start: d, end })
  }
  return { start: cols[0].start, end: cols[cols.length-1].end, columns: cols }
}

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
  const [showLibrary, setShowLibrary] = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [snapIndicator, setSnapIndicator] = useState<string | null>(null)

  const [pName, setPName] = useState('')
  const [pClient, setPClient] = useState('')
  const [pColor, setPColor] = useState(PROJ_COLORS[0])
  const [pStart, setPStart] = useState(toIso(new Date()))
  const [pEnd, setPEnd] = useState(() => { const d = new Date(); d.setMonth(d.getMonth()+3); return toIso(d) })

  const [tProject, setTProject] = useState('')
  const [tName, setTName] = useState('')
  const [tCategory, setTCategory] = useState('')
  const [tColor, setTColor] = useState(TASK_COLORS[0])
  const [tStart, setTStart] = useState(toIso(new Date()))
  const [tEnd, setTEnd] = useState(() => { const d = new Date(); d.setDate(d.getDate()+7); return toIso(d) })
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
  const dayMap = zoom === 'day' ? buildDayMap(columns) : null

  function pctFromDate(dateStr: string): number {
    if (zoom === 'day' && dayMap) {
      let d = parseDate(dateStr)
      let attempts = 0
      while (isWeekend(d) && attempts < 7) { d.setDate(d.getDate() + 1); attempts++ }
      const idx = dayMap.get(toIso(d))
      if (idx === undefined) return d < columns[0].start ? 0 : 100
      return (idx / columns.length) * 100
    }
    return ((parseDate(dateStr).getTime() - viewStart.getTime()) / 86400000 / totalDays) * 100
  }

  function pctWidth(s: string, e: string): number {
    if (zoom === 'day' && dayMap) {
      let d = parseDate(s)
      const endD = parseDate(e)
      let count = 0
      while (d < endD) { if (!isWeekend(d)) count++; d.setDate(d.getDate() + 1) }
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
    dragRef.current = { taskId, type: isResize ? 'resize' : 'move', startX: e.clientX, areaWidth: rect.width, totalDays, origStart: task.start_date, origEnd: task.end_date, dur }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  function onMouseMove(e: MouseEvent) {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    const rawDays = Math.round((dx / d.areaWidth) * d.totalDays)
    const dayWidthPx = d.areaWidth / d.totalDays
    setTasks(prev => prev.map(t => {
      if (t.id !== d.taskId) return t
      if (d.type === 'move') {
        const rawStart = addDays(d.origStart, rawDays)
        const rawEnd = addDays(d.origEnd, rawDays)
        const snapped = snapDays(t.id, rawStart, rawEnd, prev, 10, dayWidthPx)
        setSnapIndicator(snapped.start !== rawStart ? t.id : null)
        return { ...t, start_date: snapped.start, end_date: snapped.end }
      } else {
        const rawEnd = addDays(d.origEnd, rawDays)
        const snapped = snapDays(t.id, t.start_date, rawEnd, prev, 10, dayWidthPx)
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

  // Add block from library with 1 click
  async function addBlockFromLibrary(blockName: string, catColor: string, catName: string) {
    if (!selectedId) return
    const today = toIso(new Date())
    const end = addDays(today, 7)
    const t = await createTask({
      project_id: selectedId,
      name: blockName,
      category: catName,
      subcategory: null,
      color: catColor,
      start_date: today,
      end_date: end,
      progress: 0,
    })
    setTasks(prev => [...prev, t])
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

  function openNewTask() {
    setEditingTask(null)
    setTProject(selectedId || projects[0]?.id || '')
    setTName(''); setTCategory(''); setTColor(TASK_COLORS[0])
    setTStart(toIso(new Date()))
    const d2 = new Date(); d2.setDate(d2.getDate()+7); setTEnd(toIso(d2))
    setTProgress(0)
    setShowTaskModal(true)
  }

  function openEditTask(task: Task) {
    setEditingTask(task)
    setTProject(task.project_id)
    setTName(task.name)
    setTCategory(task.category)
    setTColor(task.color || TASK_COLORS[0])
    setTStart(task.start_date)
    setTEnd(task.end_date)
    setTProgress(task.progress)
    setShowTaskModal(true)
  }

  async function handleSaveTask() {
    if (!tName.trim()) return
    const payload = { project_id: tProject, name: tName, category: tCategory, subcategory: null, color: tColor, start_date: tStart, end_date: tEnd, progress: tProgress }
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

  const weekGroups: {label: string, count: number}[] = []
  if (zoom === 'day') {
    let lastWeek = -1
    columns.forEach(col => {
      const wn = getWeekNum(col.start)
      if (wn !== lastWeek) { weekGroups.push({ label: `S${wn} · ${MONTHS[col.start.getMonth()]} ${col.start.getFullYear()}`, count: 1 }); lastWeek = wn }
      else weekGroups[weekGroups.length-1].count++
    })
  }

  const anchorLabel = zoom === 'day'
    ? `${columns[0]?.sublabel} — ${columns[columns.length-1]?.sublabel}`
    : zoom === 'week'
    ? `S${getWeekNum(columns[0]?.start || new Date())} — S${getWeekNum(columns[columns.length-1]?.start || new Date())}`
    : `${MONTHS_FULL[columns[0]?.start.getMonth()]} — ${MONTHS_FULL[columns[columns.length-1]?.start.getMonth()]} ${columns[columns.length-1]?.start.getFullYear()}`

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', overflow:'hidden' }}>
      {/* TOPBAR */}
      <div style={{ background:'#144947', borderBottom:'1px solid rgba(0,0,0,0.2)', padding:'0 24px', height:54, display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0, zIndex:100 }}>
        <div style={{ fontFamily:'var(--font-display)', fontSize:21, letterSpacing:'0.12em', color:'white' }}>
          LA RÉPONSE D. <span style={{ color:'#9DD4D1' }}>·</span> RÉTRO
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <button onClick={() => setShowProjModal(true)} style={btnStyle('ghost')}>+ PROJET</button>
        </div>
      </div>

      <div style={{ display:'flex', flex:1, overflow:'hidden' }}>
        {/* SIDEBAR */}
        <div style={{ width:220, flexShrink:0, background:'#144947', borderRight:'1px solid rgba(0,0,0,0.15)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
          <div style={{ padding:'14px 12px 8px', borderBottom:'1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ fontFamily:'var(--font-display)', fontSize:10, letterSpacing:'0.2em', color:'#9DD4D1', marginBottom:8 }}>PROJETS</div>
          </div>
          <div style={{ flex:1, overflowY:'auto', padding:'6px' }}>
            {loading && <div style={{ color:'rgba(255,255,255,0.4)', fontSize:11, padding:8 }}>Chargement…</div>}
            {projects.map(p => {
              const pt = tasks.filter(t => t.project_id === p.id)
              const avg = pt.length ? Math.round(pt.reduce((a,t)=>a+t.progress,0)/pt.length) : 0
              const active = p.id === selectedId
              return (
                <div key={p.id} onClick={() => setSelectedId(p.id)} style={{ padding:'9px 10px', borderRadius:3, cursor:'pointer', marginBottom:2, border:`1.5px solid ${active?'#9DD4D1':'transparent'}`, background:active?'rgba(255,255,255,0.1)':'transparent', transition:'all 0.12s' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:7 }}>
                    <div style={{ width:7,height:7,borderRadius:'50%',background:p.color,flexShrink:0 }}/>
                    <span style={{ fontWeight:500, fontSize:11, color:'white', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.name}</span>
                    <span onClick={e=>{e.stopPropagation();handleDeleteProject(p.id)}} style={{ color:'rgba(255,255,255,0.2)', fontSize:11, cursor:'pointer', flexShrink:0 }}>✕</span>
                  </div>
                  <div style={{ fontSize:10, color:'rgba(255,255,255,0.4)', marginTop:2, paddingLeft:14 }}>{p.client} · {avg}%</div>
                  <div style={{ height:2, background:'rgba(255,255,255,0.08)', borderRadius:1, marginTop:5 }}>
                    <div style={{ height:'100%', width:`${avg}%`, background:p.color, borderRadius:1 }}/>
                  </div>
                </div>
              )
            })}
          </div>
          <div style={{ display:'flex', borderTop:'1px solid rgba(255,255,255,0.08)', flexShrink:0 }}>
            {(['gantt','overview'] as View[]).map(v => (
              <div key={v} onClick={() => setView(v)} style={{ flex:1, textAlign:'center', padding:'10px 0', fontFamily:'var(--font-display)', fontSize:11, letterSpacing:'0.1em', cursor:'pointer', color:view===v?'white':'rgba(255,255,255,0.4)', borderTop:`2px solid ${view===v?'#9DD4D1':'transparent'}` }}>
                {v === 'gantt' ? 'GANTT' : 'ANNUEL'}
              </div>
            ))}
          </div>
        </div>

        {/* MAIN */}
        <div style={{ flex:1, display:'flex', overflow:'hidden', background:'#7BBFBC' }}>
          {view === 'gantt' ? (
            <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
              {/* TOOLBAR */}
              <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 16px', background:'#5A9E9B', borderBottom:'1px solid rgba(0,0,0,0.12)', flexShrink:0 }}>
                <div style={{ fontFamily:'var(--font-display)', fontSize:20, letterSpacing:'0.08em', color:'white', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {selectedProject ? selectedProject.name : 'SÉLECTIONNER UN PROJET'}
                </div>
                {/* ZOOM */}
                <div style={{ display:'flex', borderRadius:2, overflow:'hidden', border:'1px solid rgba(255,255,255,0.2)', flexShrink:0 }}>
                  {(['day','week','month'] as ZoomLevel[]).map(z => (
                    <button key={z} onClick={()=>setZoom(z)} style={{ padding:'5px 10px', background:zoom===z?'white':'transparent', color:zoom===z?'#144947':'white', border:'none', cursor:'pointer', fontFamily:'var(--font-display)', fontSize:11, letterSpacing:'0.08em', borderLeft:z!=='day'?'1px solid rgba(255,255,255,0.2)':'none' }}>
                      {z === 'day' ? 'JOUR' : z === 'week' ? 'SEM.' : 'MOIS'}
                    </button>
                  ))}
                </div>
                {/* NAV */}
                <div style={{ display:'flex', alignItems:'center', gap:5, flexShrink:0 }}>
                  <button onClick={()=>shiftAnchor(-1)} style={navBtnStyle}>‹</button>
                  <div style={{ fontFamily:'var(--font-display)', fontSize:10, letterSpacing:'0.06em', minWidth:150, textAlign:'center', color:'white' }}>{anchorLabel}</div>
                  <button onClick={()=>shiftAnchor(1)} style={navBtnStyle}>›</button>
                  <button onClick={()=>setAnchor(new Date())} style={{ ...navBtnStyle, fontSize:9, width:'auto', padding:'0 8px', fontFamily:'var(--font-display)' }}>AUJ.</button>
                </div>
                {/* ADD BUTTONS */}
                {selectedProject && (
                  <>
                    <button onClick={()=>setShowLibrary(v=>!v)} style={{ ...btnStyle('primary'), background: showLibrary?'#9DD4D1':'white', flexShrink:0 }}>
                      {showLibrary ? '✕ FERMER' : '+ BLOC'}
                    </button>
                    <button onClick={openNewTask} style={{ ...btnStyle('ghost'), flexShrink:0, fontSize:11 }}>LIBRE</button>
                  </>
                )}
              </div>

              <div style={{ flex:1, display:'flex', overflow:'hidden' }}>
                {/* GANTT GRID */}
                <div style={{ flex:1, overflowY:'auto', overflowX:'auto' }}>
                  <div style={{ minWidth: zoom==='day'?columns.length*44+200:860, display:'flex', flexDirection:'column' }}>
                    {/* WEEK GROUP HEADER */}
                    {zoom === 'day' && (
                      <div style={{ display:'flex', position:'sticky', top:0, zIndex:11, background:'#4A8E8B', borderBottom:'1px solid rgba(0,0,0,0.1)' }}>
                        <div style={{ width:200, flexShrink:0, borderRight:'1px solid rgba(0,0,0,0.1)' }}/>
                        <div style={{ flex:1, display:'flex' }}>
                          {weekGroups.map((wg, i) => (
                            <div key={i} style={{ width:`${(wg.count/columns.length)*100}%`, height:20, display:'flex', alignItems:'center', paddingLeft:8, fontFamily:'var(--font-display)', fontSize:9, letterSpacing:'0.12em', color:'rgba(255,255,255,0.5)', borderLeft:i>0?'1px solid rgba(0,0,0,0.1)':'none', whiteSpace:'nowrap', overflow:'hidden' }}>{wg.label}</div>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* COLUMN HEADER */}
                    <div style={{ display:'flex', position:'sticky', top:zoom==='day'?20:0, zIndex:10, background:'#5A9E9B', borderBottom:'1px solid rgba(0,0,0,0.12)' }}>
                      <div style={{ width:200, flexShrink:0, borderRight:'1px solid rgba(0,0,0,0.12)' }}>
                        <div style={{ height:36, display:'flex', alignItems:'center', padding:'0 16px', fontFamily:'var(--font-display)', fontSize:10, letterSpacing:'0.18em', color:'rgba(255,255,255,0.5)' }}>TÂCHE</div>
                      </div>
                      <div style={{ flex:1, display:'flex' }}>
                        {columns.map((col, i) => (
                          <div key={col.key} style={{ flex:1, height:36, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', fontFamily:'var(--font-display)', fontSize:zoom==='day'?13:11, letterSpacing:'0.08em', color:col.isToday?'white':'rgba(255,255,255,0.65)', borderLeft:i>0?'1px solid rgba(0,0,0,0.1)':'none', background:col.isToday?'rgba(255,255,255,0.18)':'transparent', whiteSpace:'nowrap' }}>
                            <span style={{ fontWeight:col.isToday?700:400 }}>{col.label}</span>
                            {zoom !== 'day' && col.sublabel && <span style={{ fontSize:9, opacity:0.5, marginTop:1 }}>{col.sublabel}</span>}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* TASK ROWS */}
                    {!selectedProject ? (
                      <div style={{ padding:'60px 0', textAlign:'center', color:'rgba(255,255,255,0.4)' }}>
                        <div style={{ fontFamily:'var(--font-display)', fontSize:18, letterSpacing:'0.1em' }}>SÉLECTIONNER UN PROJET</div>
                      </div>
                    ) : projTasks.length === 0 ? (
                      <div style={{ padding:'50px 0', textAlign:'center', color:'rgba(255,255,255,0.4)' }}>
                        <div style={{ fontFamily:'var(--font-display)', fontSize:18, letterSpacing:'0.1em', marginBottom:8 }}>AUCUNE TÂCHE</div>
                        <div style={{ fontSize:12, marginBottom:16 }}>Clique sur "+ BLOC" pour ajouter des étapes</div>
                        <button onClick={()=>setShowLibrary(true)} style={btnStyle('primary')}>+ AJOUTER UN BLOC</button>
                      </div>
                    ) : (
                      projTasks.map(task => {
                        const l = Math.max(0, pctFromDate(task.start_date))
                        const w = Math.max(0.5, pctWidth(task.start_date, task.end_date))
                        const isSnapping = snapIndicator === task.id
                        return (
                          <div key={task.id} style={{ display:'flex', borderBottom:'1px solid rgba(0,0,0,0.08)', minHeight:48 }}>
                            <div onClick={() => openEditTask(task)} style={{ width:200, flexShrink:0, borderRight:'1px solid rgba(0,0,0,0.08)', padding:'7px 14px', display:'flex', flexDirection:'column', justifyContent:'center', background:'rgba(255,255,255,0.06)', cursor:'pointer', position:'sticky', left:0, zIndex:5 }}
                              onMouseEnter={e=>(e.currentTarget.style.background='rgba(255,255,255,0.12)')}
                              onMouseLeave={e=>(e.currentTarget.style.background='rgba(255,255,255,0.06)')}
                            >
                              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                                <div style={{ width:6,height:6,borderRadius:'50%',background:task.color,flexShrink:0 }}/>
                                <div style={{ fontWeight:500, fontSize:11, color:'white', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{task.name}</div>
                              </div>
                              <div style={{ fontSize:10, color:'rgba(255,255,255,0.35)', marginTop:2, paddingLeft:12 }}>
                                {fmtShort(task.start_date)} → {fmtShort(task.end_date)}
                              </div>
                            </div>
                            <div className="bars-area" style={{ flex:1, position:'relative', display:'flex', alignItems:'center' }}>
                              {columns.map((col, i) => (
                                <div key={col.key} style={{ position:'absolute',top:0,bottom:0,left:`${(i/columns.length)*100}%`,width:`${100/columns.length}%`,background:col.isToday?'rgba(255,255,255,0.06)':'transparent',borderLeft:i>0?'1px solid rgba(0,0,0,0.06)':'none',pointerEvents:'none' }}/>
                              ))}
                              {todayPct>=0&&todayPct<=100&&(
                                <div style={{ position:'absolute',top:0,bottom:0,left:`${todayPct}%`,width:2,background:'rgba(255,255,255,0.7)',zIndex:4,pointerEvents:'none' }}/>
                              )}
                              <div
                                onMouseDown={e => onMouseDownBar(e, task.id, false)}
                                style={{ position:'absolute', height:26, left:`${l}%`, width:`${w}%`, minWidth:6, background:task.color, borderRadius:2, cursor:'grab', display:'flex', alignItems:'center', padding:'0 8px', fontSize:10, fontWeight:500, color:'white', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', userSelect:'none', zIndex:2, textShadow:'0 1px 2px rgba(0,0,0,0.3)', outline:isSnapping?'2px solid white':'none' }}
                              >
                                <div style={{ position:'absolute',left:0,top:0,bottom:0,width:`${task.progress}%`,background:'rgba(0,0,0,0.2)',borderRadius:'2px 0 0 2px',pointerEvents:'none' }}/>
                                <span style={{ position:'relative',zIndex:1 }}>{task.name}</span>
                                <div onMouseDown={e=>onMouseDownBar(e,task.id,true)} style={{ position:'absolute',right:0,top:0,bottom:0,width:8,cursor:'col-resize',background:'rgba(0,0,0,0.2)',borderRadius:'0 2px 2px 0' }}/>
                              </div>
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                </div>

                {/* BLOCK LIBRARY PANEL */}
                {showLibrary && (
                  <div style={{ width:260, flexShrink:0, background:'#144947', borderLeft:'1px solid rgba(0,0,0,0.2)', overflowY:'auto', display:'flex', flexDirection:'column' }}>
                    <div style={{ padding:'14px 14px 10px', borderBottom:'1px solid rgba(255,255,255,0.08)', position:'sticky', top:0, background:'#144947', zIndex:5 }}>
                      <div style={{ fontFamily:'var(--font-display)', fontSize:11, letterSpacing:'0.18em', color:'#9DD4D1' }}>AJOUTER UN BLOC</div>
                      <div style={{ fontSize:10, color:'rgba(255,255,255,0.35)', marginTop:4 }}>Clic = ajouté à aujourd'hui</div>
                    </div>
                    <div style={{ padding:'8px' }}>
                      {BLOCK_LIBRARY.map(cat => (
                        <div key={cat.category} style={{ marginBottom:16 }}>
                          <div style={{ display:'flex', alignItems:'center', gap:6, padding:'4px 6px 8px' }}>
                            <div style={{ width:8,height:8,borderRadius:'50%',background:cat.color }}/>
                            <span style={{ fontFamily:'var(--font-display)', fontSize:11, letterSpacing:'0.15em', color:'rgba(255,255,255,0.6)' }}>{cat.category}</span>
                          </div>
                          <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
                            {cat.blocks.map(block => (
                              <button
                                key={block}
                                onClick={() => addBlockFromLibrary(block, cat.color, cat.category)}
                                style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', background:'rgba(255,255,255,0.06)', border:'1px solid transparent', borderRadius:3, cursor:'pointer', textAlign:'left', transition:'all 0.12s', color:'white', fontSize:12, fontFamily:'var(--font-body)' }}
                                onMouseEnter={e=>{ e.currentTarget.style.background='rgba(255,255,255,0.14)'; e.currentTarget.style.borderColor=cat.color }}
                                onMouseLeave={e=>{ e.currentTarget.style.background='rgba(255,255,255,0.06)'; e.currentTarget.style.borderColor='transparent' }}
                              >
                                <div style={{ width:5,height:5,borderRadius:'50%',background:cat.color,flexShrink:0 }}/>
                                {block}
                                <span style={{ marginLeft:'auto', color:'rgba(255,255,255,0.25)', fontSize:14 }}>+</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <OverviewPanel projects={projects} tasks={tasks} year={overviewYear} onYearChange={setOverviewYear} onSelectProject={id=>{setSelectedId(id);setView('gantt')}} />
          )}
        </div>
      </div>

      {/* PROJECT MODAL */}
      {showProjModal && (
        <Modal onClose={() => setShowProjModal(false)} title="NOUVEAU PROJET">
          <FormRow label="NOM DU PROJET"><input type="text" value={pName} onChange={e=>setPName(e.target.value)} placeholder="ex. SALON M&O 2025" autoFocus/></FormRow>
          <FormRow label="CLIENT"><input type="text" value={pClient} onChange={e=>setPClient(e.target.value)} placeholder="ex. Valentino"/></FormRow>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:14 }}>
            <FormRow label="DÉBUT"><input type="date" value={pStart} onChange={e=>setPStart(e.target.value)}/></FormRow>
            <FormRow label="FIN"><input type="date" value={pEnd} onChange={e=>setPEnd(e.target.value)}/></FormRow>
          </div>
          <FormRow label="COULEUR"><ColorPicker colors={PROJ_COLORS} selected={pColor} onSelect={setPColor}/></FormRow>
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:22 }}>
            <button onClick={()=>setShowProjModal(false)} style={btnStyle('ghost')}>Annuler</button>
            <button onClick={handleCreateProject} style={btnStyle('primary')}>CRÉER</button>
          </div>
        </Modal>
      )}

      {/* TASK EDIT MODAL */}
      {showTaskModal && (
        <Modal onClose={() => setShowTaskModal(false)} title={editingTask ? 'MODIFIER' : 'NOUVEAU BLOC LIBRE'}>
          <FormRow label="PROJET">
            <select value={tProject} onChange={e=>setTProject(e.target.value)}>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </FormRow>
          <FormRow label="NOM"><input type="text" value={tName} onChange={e=>setTName(e.target.value)} placeholder="Nom du bloc" autoFocus/></FormRow>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:14 }}>
            <FormRow label="DÉBUT"><input type="date" value={tStart} onChange={e=>setTStart(e.target.value)}/></FormRow>
            <FormRow label="FIN"><input type="date" value={tEnd} onChange={e=>setTEnd(e.target.value)}/></FormRow>
          </div>
          <FormRow label="COULEUR"><ColorPicker colors={TASK_COLORS} selected={tColor} onSelect={setTColor}/></FormRow>
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
              <span style={{ fontFamily:'var(--font-display)', fontSize:14, letterSpacing:'0.1em', color:'white' }}>{proj.name}</span>
              <span style={{ fontSize:10, color:'rgba(255,255,255,0.4)' }}>{proj.client}</span>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:5 }}>
              <div style={{ width:170, flexShrink:0 }}/>
              <div style={{ flex:1, height:18, borderRadius:2, background:'rgba(0,0,0,0.15)', position:'relative' }}>
                {todayPct>=0&&<div style={{ position:'absolute',top:0,bottom:0,left:`${todayPct}%`,width:2,background:'rgba(255,255,255,0.6)',zIndex:3 }}/>}
                {pt.map(t => { const l=pct(t.start_date),w=Math.max(0.3,pct(t.end_date)-l); return <div key={t.id} style={{ position:'absolute',height:'100%',left:`${l}%`,width:`${w}%`,background:proj.color,opacity:0.6,borderRadius:2 }}/> })}
              </div>
            </div>
            {pt.map(t => {
              const l=pct(t.start_date),w=Math.max(0.3,pct(t.end_date)-l)
              return (
                <div key={t.id} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:3 }}>
                  <div style={{ width:170, flexShrink:0, fontSize:10, color:'rgba(255,255,255,0.45)', paddingLeft:16, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{t.name}</div>
                  <div style={{ flex:1, height:12, borderRadius:2, background:'rgba(0,0,0,0.1)', position:'relative' }}>
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
      <div style={{ background:'#144947',border:'1px solid #1E6B68',borderRadius:4,width:440,maxWidth:'95vw',padding:26,position:'relative',maxHeight:'90vh',overflowY:'auto' }}>
        <button onClick={onClose} style={{ position:'absolute',top:12,right:12,background:'none',border:'none',color:'rgba(255,255,255,0.35)',fontSize:18,cursor:'pointer' }}>✕</button>
        <div style={{ fontFamily:'var(--font-display)',fontSize:20,letterSpacing:'0.1em',color:'white',marginBottom:20 }}>{title}</div>
        {children}
      </div>
    </div>
  )
}

function FormRow({ label, children }:{ label:string, children:React.ReactNode }) {
  return (
    <div style={{ marginBottom:13 }}>
      <label style={{ display:'block',fontFamily:'var(--font-display)',fontSize:10,letterSpacing:'0.18em',color:'#9DD4D1',marginBottom:5 }}>{label}</label>
      {children}
    </div>
  )
}

function btnStyle(type:'primary'|'ghost'): React.CSSProperties {
  return { fontFamily:'var(--font-display)', fontSize:12, padding:'6px 14px', borderRadius:2, border:type==='ghost'?'1.5px solid rgba(255,255,255,0.25)':'none', background:type==='primary'?'white':'transparent', color:type==='primary'?'#144947':'white', cursor:'pointer', letterSpacing:'0.08em' }
}

const navBtnStyle: React.CSSProperties = { width:28, height:28, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(255,255,255,0.1)', border:'1px solid rgba(255,255,255,0.2)', borderRadius:2, cursor:'pointer', fontSize:15, color:'white' }
