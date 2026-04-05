'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  supabase, getProjects, createProject, deleteProject,
  getLanes, createLane, updateLane, deleteLane,
  getAllTasks, createTask, updateTask, deleteTask,
  getAttachments, addAttachment, deleteAttachment, uploadFile,
  BLOCK_LIBRARY, PROJ_COLORS, TASK_COLORS,
  type Project, type Lane, type Task, type Attachment,
} from '@/lib/supabase'

const MONTHS = ['JAN','FÉV','MAR','AVR','MAI','JUN','JUL','AOÛ','SEP','OCT','NOV','DÉC']
const MONTHS_FULL = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre']
const DAY_LETTERS = ['D','L','M','M','J','V','S']

function toIso(d: Date) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }
function parseDate(s: string) { return new Date(s + 'T00:00:00') }
function fmtShort(s: string) { const d = parseDate(s); return `${d.getDate()} ${MONTHS[d.getMonth()]}` }
function addDays(dateStr: string, n: number) { const d = parseDate(dateStr); d.setDate(d.getDate() + n); return toIso(d) }
function isWeekend(d: Date) { return d.getDay() === 0 || d.getDay() === 6 }
function startOfWeek(dateStr: string) { const d = parseDate(dateStr); const day = d.getDay(); d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day)); return toIso(d) }
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
  columns.forEach((col, i) => map.set(col.key, i))
  return map
}

function snapDays(taskId: string, newStart: string, newEnd: string, allTasks: Task[], threshold: number): { start: string; end: string } {
  const dur = (parseDate(newEnd).getTime() - parseDate(newStart).getTime()) / 86400000
  let bestDelta = 0, bestDist = threshold + 1
  for (const t of allTasks) {
    if (t.id === taskId) continue
    const d1 = (parseDate(t.end_date).getTime() - parseDate(newStart).getTime()) / 86400000
    if (Math.abs(d1) <= threshold && Math.abs(d1) < bestDist) { bestDelta = d1; bestDist = Math.abs(d1) }
    const d2 = (parseDate(t.start_date).getTime() - parseDate(newEnd).getTime()) / 86400000
    if (Math.abs(d2) <= threshold && Math.abs(d2) < bestDist) { bestDelta = d2; bestDist = Math.abs(d2) }
    const d3 = (parseDate(t.start_date).getTime() - parseDate(newStart).getTime()) / 86400000
    if (Math.abs(d3) <= threshold && Math.abs(d3) < bestDist) { bestDelta = d3; bestDist = Math.abs(d3) }
  }
  if (bestDist <= threshold) {
    const s = addDays(newStart, bestDelta)
    return { start: s, end: addDays(s, dur) }
  }
  return { start: newStart, end: newEnd }
}

export default function Home() {
  const [theme, setTheme] = useState<'light'|'dark'>('light')
  const [projects, setProjects] = useState<Project[]>([])
  const [lanes, setLanes] = useState<Lane[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<View>('gantt')
  const [zoom, setZoom] = useState<ZoomLevel>('day')
  const [anchor, setAnchor] = useState(new Date())
  const [overviewYear, setOverviewYear] = useState(new Date().getFullYear())
  const [loading, setLoading] = useState(true)
  const [showProjModal, setShowProjModal] = useState(false)
  const [showTaskModal, setShowTaskModal] = useState(false)
  const [showLibrary, setShowLibrary] = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set())
  const [libraryTargetLane, setLibraryTargetLane] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [newUrl, setNewUrl] = useState('')
  const [newUrlName, setNewUrlName] = useState('')
  const [uploadingFile, setUploadingFile] = useState(false)

  // Lasso
  const [lasso, setLasso] = useState<{x:number,y:number,w:number,h:number} | null>(null)
  const lassoStart = useRef<{x:number,y:number} | null>(null)
  const ganttRef = useRef<HTMLDivElement>(null)

  // Lane drag reorder
  const laneDragRef = useRef<{laneId:string, startY:number, currentOrder:number} | null>(null)
  const [draggingLaneId, setDraggingLaneId] = useState<string|null>(null)
  const [hoveredLaneId, setHoveredLaneId] = useState<string|null>(null)

  // Block drag
  const hoveredLaneRef = useRef<string|null>(null)
  const [ganttZoom, setGanttZoom] = useState(1)
  const [dropLaneHighlight, setDropLaneHighlight] = useState<string|null>(null)
  const blockDragRef = useRef<{
    taskIds: string[], type: 'move'|'resize',
    startX: number, areaWidth: number, totalDays: number,
    origStarts: Map<string,string>, origEnds: Map<string,string>, dur: number,
    resizeTaskId?: string,
  } | null>(null)

  const [pName, setPName] = useState('')
  const [pClient, setPClient] = useState('')
  const [pColor, setPColor] = useState(PROJ_COLORS[0])
  const [pStart, setPStart] = useState(toIso(new Date()))
  const [pEnd, setPEnd] = useState(() => { const d = new Date(); d.setMonth(d.getMonth()+3); return toIso(d) })
  const [tProject, setTProject] = useState('')
  const [tName, setTName] = useState('')
  const [tColor, setTColor] = useState(TASK_COLORS[0])
  const [tStart, setTStart] = useState(toIso(new Date()))
  const [tEnd, setTEnd] = useState(() => { const d = new Date(); d.setDate(d.getDate()+7); return toIso(d) })
  const [tProgress, setTProgress] = useState(0)
  const [tLane, setTLane] = useState('')

  // Delete selected tasks with Backspace/Delete key
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedTaskIds.size > 0) {
        const active = document.activeElement
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return
        for (const id of Array.from(selectedTaskIds)) {
          await deleteTask(id)
        }
        setTasks(prev => prev.filter(t => !selectedTaskIds.has(t.id)))
        setSelectedTaskIds(new Set())
        await load()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectedTaskIds])

  const load = useCallback(async (projId?: string) => {
    setLoading(true)
    const [projs, tsks] = await Promise.all([getProjects(), getAllTasks()])
    setProjects(projs)
    setTasks(tsks)
    const pid = projId || selectedId || projs[0]?.id
    if (pid) {
      setSelectedId(pid)
      const ls = await getLanes(pid)
      setLanes(ls)
    }
    setLoading(false)
  }, [selectedId])

  useEffect(() => { load() }, [])

  useEffect(() => {
    const ch = supabase.channel('lrd-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lanes' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => load())
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [load])

  async function selectProject(id: string) {
    setSelectedId(id)
    setSelectedTaskIds(new Set())
    const ls = await getLanes(id)
    setLanes(ls)
  }

  const { start: viewStart, end: viewEnd, columns } = getViewRange(zoom, anchor)
  const totalDays = (viewEnd.getTime() - viewStart.getTime()) / 86400000
  const dayMap = zoom === 'day' ? buildDayMap(columns) : null

  function pctFromDate(dateStr: string): number {
    if (zoom === 'day' && dayMap) {
      let d = parseDate(dateStr); let a = 0
      while (isWeekend(d) && a < 7) { d.setDate(d.getDate() + 1); a++ }
      const idx = dayMap.get(toIso(d))
      if (idx === undefined) return d < columns[0].start ? 0 : 100
      return (idx / columns.length) * 100
    }
    return ((parseDate(dateStr).getTime() - viewStart.getTime()) / 86400000 / totalDays) * 100
  }

  function pctWidth(s: string, e: string): number {
    if (zoom === 'day' && dayMap) {
      let d = parseDate(s); const endD = parseDate(e); let count = 0
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

  // ── LANE REORDER ──────────────────────────────────────────────────────────
  function onLaneDragStart(e: React.MouseEvent, laneId: string, order: number) {
    e.preventDefault()
    laneDragRef.current = { laneId, startY: e.clientY, currentOrder: order }
    setDraggingLaneId(laneId)
    window.addEventListener('mousemove', onLaneDragMove)
    window.addEventListener('mouseup', onLaneDragEnd)
  }

  function onLaneDragMove(e: MouseEvent) {
    if (!laneDragRef.current) return
    const dy = e.clientY - laneDragRef.current.startY
    const rowH = 58
    const delta = Math.round(dy / rowH)
    if (delta === 0) return
    setLanes(prev => {
      const sorted = [...prev].sort((a,b) => a.sort_order - b.sort_order)
      const idx = sorted.findIndex(l => l.id === laneDragRef.current!.laneId)
      if (idx < 0) return prev
      const newIdx = Math.max(0, Math.min(sorted.length-1, idx + delta))
      if (newIdx === idx) return prev
      const moved = sorted.splice(idx, 1)[0]
      sorted.splice(newIdx, 0, moved)
      return sorted.map((l, i) => ({ ...l, sort_order: i }))
    })
    laneDragRef.current.startY = e.clientY
  }

  async function onLaneDragEnd() {
    setDraggingLaneId(null)
    window.removeEventListener('mousemove', onLaneDragMove)
    window.removeEventListener('mouseup', onLaneDragEnd)
    // Persist new order
    for (const lane of lanes) {
      await updateLane(lane.id, { sort_order: lane.sort_order })
    }
    laneDragRef.current = null
  }

  // ── BLOCK DRAG ────────────────────────────────────────────────────────────
  function onMouseDownBar(e: React.MouseEvent, taskId: string, isResize: boolean) {
    e.preventDefault()
    if (isResize) e.stopPropagation()

    // Build selection
    let ids: string[]
    if (selectedTaskIds.has(taskId)) {
      ids = Array.from(selectedTaskIds)
    } else {
      if (!e.shiftKey) setSelectedTaskIds(new Set([taskId]))
      ids = [taskId]
    }

    const barsArea = (e.currentTarget as HTMLElement).closest('.bars-area') as HTMLElement
    const rect = barsArea.getBoundingClientRect()
    const origStarts = new Map<string,string>()
    const origEnds = new Map<string,string>()
    ids.forEach(id => {
      const t = tasks.find(x => x.id === id)
      if (t) { origStarts.set(id, t.start_date); origEnds.set(id, t.end_date) }
    })
    const task = tasks.find(t => t.id === taskId)!
    const dur = (parseDate(task.end_date).getTime() - parseDate(task.start_date).getTime()) / 86400000

    blockDragRef.current = { taskIds: ids, type: isResize ? 'resize' : 'move', startX: e.clientX, areaWidth: rect.width, totalDays, origStarts, origEnds, dur, resizeTaskId: isResize ? taskId : undefined }
    window.addEventListener('mousemove', onBlockDragMove)
    window.addEventListener('mouseup', (e) => onBlockDragEnd(e))
  }

  function onBlockDragMove(e: MouseEvent) {
    const d = blockDragRef.current
    if (!d) return
    // Track which lane is hovered via ref
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const laneEl = el?.closest('[data-lane-id]') as HTMLElement | null
    const lid = laneEl?.dataset.laneId || null
    hoveredLaneRef.current = lid
    setDropLaneHighlight(lid)
    const dx = e.clientX - d.startX
    const rawDays = Math.round((dx / d.areaWidth) * d.totalDays)
    const snapThreshold = Math.max(1, Math.round(10 / (d.areaWidth / d.totalDays)))

    setTasks(prev => prev.map(t => {
      if (!d.taskIds.includes(t.id)) return t
      const origS = d.origStarts.get(t.id)!
      const origE = d.origEnds.get(t.id)!
      if (d.type === 'move') {
        const rawStart = addDays(origS, rawDays)
        const rawEnd = addDays(origE, rawDays)
        const snapped = snapDays(t.id, rawStart, rawEnd, prev, snapThreshold)
        return { ...t, start_date: snapped.start, end_date: snapped.end }
      } else if (d.resizeTaskId === t.id) {
        const rawEnd = addDays(origE, rawDays)
        const snapped = snapDays(t.id, t.start_date, rawEnd, prev, snapThreshold)
        if (parseDate(snapped.end) > parseDate(t.start_date)) return { ...t, end_date: snapped.end }
        return t
      }
      return t
    }))
  }

  async function onBlockDragEnd(e?: MouseEvent) {
    const d = blockDragRef.current
    const targetLaneId = hoveredLaneRef.current
    blockDragRef.current = null
    hoveredLaneRef.current = null
    setDropLaneHighlight(null)
    window.removeEventListener('mousemove', onBlockDragMove)
    window.removeEventListener('mouseup', onBlockDragEnd)
    if (!d) return
    for (const id of d.taskIds) {
      const task = tasks.find(t => t.id === id)
      if (task) {
        const updates: Record<string,unknown> = { start_date: task.start_date, end_date: task.end_date }
        if (targetLaneId && targetLaneId !== task.lane_id) {
          updates.lane_id = targetLaneId
          setTasks(prev => prev.map(t => t.id === id ? { ...t, lane_id: targetLaneId } : t))
        }
        await updateTask(task.id, updates)
      }
    }
  }

  // ── LASSO ─────────────────────────────────────────────────────────────────
  function onGanttMouseDown(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('.gantt-bar')) return
    if ((e.target as HTMLElement).closest('.task-label-col')) return
    if ((e.target as HTMLElement).closest('.lane-handle')) return
    if (!e.shiftKey) setSelectedTaskIds(new Set())
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    lassoStart.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    setLasso({ x: e.clientX - rect.left, y: e.clientY - rect.top, w: 0, h: 0 })
    window.addEventListener('mousemove', onLassoMove)
    window.addEventListener('mouseup', onLassoEnd)
  }

  function onLassoMove(e: MouseEvent) {
    if (!lassoStart.current || !ganttRef.current) return
    const rect = ganttRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    setLasso({
      x: Math.min(x, lassoStart.current.x),
      y: Math.min(y, lassoStart.current.y),
      w: Math.abs(x - lassoStart.current.x),
      h: Math.abs(y - lassoStart.current.y),
    })
  }

  function onLassoEnd(e: MouseEvent) {
    window.removeEventListener('mousemove', onLassoMove)
    window.removeEventListener('mouseup', onLassoEnd)
    if (!lassoStart.current || !ganttRef.current || !lasso) { setLasso(null); lassoStart.current = null; return }
    // Find tasks whose bars overlap lasso rect
    const bars = ganttRef.current.querySelectorAll('.gantt-bar[data-task-id]')
    const lassoRect = ganttRef.current.getBoundingClientRect()
    const sel = new Set<string>(e.shiftKey ? Array.from(selectedTaskIds) : [])
    bars.forEach(bar => {
      const br = bar.getBoundingClientRect()
      const bx = br.left - lassoRect.left
      const by = br.top - lassoRect.top
      const bw = br.width, bh = br.height
      const lx = lasso.x, ly = lasso.y, lw = lasso.w, lh = lasso.h
      if (bx < lx+lw && bx+bw > lx && by < ly+lh && by+bh > ly) {
        sel.add(bar.getAttribute('data-task-id')!)
      }
    })
    setSelectedTaskIds(sel)
    setLasso(null)
    lassoStart.current = null
  }

  // ── LANES ─────────────────────────────────────────────────────────────────
  async function addLane() {
    if (!selectedId) return
    const order = lanes.length
    const lane = await createLane({ project_id: selectedId, name: `Ligne ${order + 1}`, sort_order: order })
    setLanes(prev => [...prev, lane])
  }

  async function renameLane(id: string, name: string) {
    await updateLane(id, { name })
    setLanes(prev => prev.map(l => l.id === id ? { ...l, name } : l))
  }

  async function removeLane(id: string) {
    await deleteLane(id)
    setLanes(prev => prev.filter(l => l.id !== id))
    setTasks(prev => prev.filter(t => t.lane_id !== id))
  }

  // ── ADD BLOCK ─────────────────────────────────────────────────────────────
  async function addBlockFromLibrary(blockName: string, catColor: string, catName: string) {
    if (!selectedId) return
    let laneId = libraryTargetLane
    if (!laneId) {
      if (lanes.length === 0) {
        const lane = await createLane({ project_id: selectedId, name: 'Ligne 1', sort_order: 0 })
        setLanes([lane])
        laneId = lane.id
      } else {
        laneId = lanes[0].id
      }
    }
    // Place after last block on this lane
    const laneTasks = tasks.filter(t => t.lane_id === laneId)
    let startDate = toIso(new Date())
    if (laneTasks.length > 0) {
      const lastEnd = laneTasks.reduce((max, t) => t.end_date > max ? t.end_date : max, laneTasks[0].end_date)
      startDate = lastEnd
    }
    const t = await createTask({ project_id: selectedId, lane_id: laneId, name: blockName, category: catName, subcategory: null, color: catColor, start_date: startDate, end_date: addDays(startDate, 7), progress: 0 })
    setTasks(prev => [...prev, t])
  }

  async function handleCreateProject() {
    if (!pName.trim()) return
    const proj = await createProject({ name: pName.toUpperCase(), client: pClient, color: pColor, start_date: pStart, end_date: pEnd })
    setProjects(prev => [...prev, proj])
    await selectProject(proj.id)
    setShowProjModal(false)
    setPName(''); setPClient('')
  }

  async function handleDeleteProject(id: string) {
    if (!confirm('Supprimer ce projet ?')) return
    await deleteProject(id)
    setProjects(prev => prev.filter(p => p.id !== id))
    setTasks(prev => prev.filter(t => t.project_id !== id))
    setLanes([])
    if (selectedId === id) setSelectedId(projects.find(p => p.id !== id)?.id || null)
  }

  async function openEditTask(task: Task) {
    setEditingTask(task)
    const atts = await getAttachments(task.id)
    setAttachments(atts)
    setTProject(task.project_id)
    setTName(task.name)
    setTColor(task.color || TASK_COLORS[0])
    setTStart(task.start_date)
    setTEnd(task.end_date)
    setTProgress(task.progress)
    setTLane(task.lane_id)
    setShowTaskModal(true)
  }

  async function handleSaveTask() {
    if (!editingTask) return
    const payload = { name: tName, color: tColor, start_date: tStart, end_date: tEnd, progress: tProgress, lane_id: tLane }
    await updateTask(editingTask.id, payload)
    setTasks(prev => prev.map(t => t.id === editingTask.id ? { ...t, ...payload } : t))
    setShowTaskModal(false)
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!editingTask || !e.target.files?.[0]) return
    setUploadingFile(true)
    try {
      const file = e.target.files[0]
      const url = await uploadFile(file, editingTask.id)
      const att = await addAttachment({ task_id: editingTask.id, type: 'file', name: file.name, url })
      setAttachments(prev => [...prev, att])
    } catch(err) { console.error(err) }
    setUploadingFile(false)
  }

  async function handleAddUrl() {
    if (!editingTask || !newUrl.trim()) return
    const att = await addAttachment({ task_id: editingTask.id, type: 'url', name: newUrlName || newUrl, url: newUrl })
    setAttachments(prev => [...prev, att])
    setNewUrl(''); setNewUrlName('')
  }

  async function handleDeleteAttachment(id: string) {
    await deleteAttachment(id)
    setAttachments(prev => prev.filter(a => a.id !== id))
  }

  async function handleDeleteTask() {
    if (!editingTask) return
    await deleteTask(editingTask.id)
    setTasks(prev => prev.filter(t => t.id !== editingTask.id))
    setShowTaskModal(false)
    await load()
  }

  async function deleteSelected() {
    for (const id of Array.from(selectedTaskIds)) {
      await deleteTask(id)
    }
    setTasks(prev => prev.filter(t => !selectedTaskIds.has(t.id)))
    setSelectedTaskIds(new Set())
    await load()
  }

  const selectedProject = projects.find(p => p.id === selectedId)
  const projTasks = tasks.filter(t => t.project_id === selectedId)
  const todayPct = Math.max(0, Math.min(100, pctFromDate(toIso(new Date()))))
  const sortedLanes = [...lanes].sort((a,b) => a.sort_order - b.sort_order)

  const weekGroups: {label:string,count:number}[] = []
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
    ? `S${getWeekNum(columns[0]?.start||new Date())} — S${getWeekNum(columns[columns.length-1]?.start||new Date())}`
    : `${MONTHS_FULL[columns[0]?.start.getMonth()]} — ${MONTHS_FULL[columns[columns.length-1]?.start.getMonth()]} ${columns[columns.length-1]?.start.getFullYear()}`

  return (
    <div data-theme={theme} style={{ display:'flex', flexDirection:'column', height:'100vh', overflow:'hidden', background:'var(--bg)', color:'var(--text)' }}>
      {/* TOPBAR */}
      <div style={{ background:'#144947', borderBottom:'1px solid rgba(0,0,0,0.2)', padding:'0 24px', height:64, display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0, zIndex:100 }}>
        <div style={{ fontFamily:'var(--font-display)', fontSize:26, letterSpacing:'0.12em', color:'white' }}>
          LA RÉPONSE D. <span style={{ color:'#9DD4D1' }}>·</span> RÉTRO
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          {selectedTaskIds.size > 0 && (
            <span style={{ fontSize:11, color:'#9DD4D1', fontFamily:'var(--font-display)', letterSpacing:'0.1em' }}>
              {selectedTaskIds.size} BLOC{selectedTaskIds.size>1?'S':''} SÉLECTIONNÉ{selectedTaskIds.size>1?'S':''}
              <button onClick={deleteSelected} style={{ ...btnStyle('ghost'), marginLeft:8, color:'#ff8080', borderColor:'rgba(255,100,100,0.3)', fontSize:10 }}>SUPPRIMER</button>
              <button onClick={()=>setSelectedTaskIds(new Set())} style={{ ...btnStyle('ghost'), marginLeft:4, fontSize:10 }}>✕</button>
            </span>
          )}
          <button onClick={()=>setTheme(t=>t==='light'?'dark':'light')} style={{ background:'rgba(255,255,255,0.15)', border:'1px solid rgba(255,255,255,0.3)', borderRadius:2, color:'white', cursor:'pointer', fontSize:16, padding:'4px 10px' }} title="Mode sombre">{theme==='light'?'◐':'○'}</button>
          <button onClick={() => setShowProjModal(true)} style={btnStyle('primary')}>+ PROJET</button>
        </div>
      </div>

      <div style={{ display:'flex', flex:1, overflow:'hidden' }}>
        {/* SIDEBAR */}
        <div style={{ width:260, flexShrink:0, background:'var(--sidebar)', borderRight:'1px solid var(--border)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
          <div style={{ padding:'14px 12px 8px', borderBottom:'1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ fontFamily:'var(--font-display)', fontSize:11, letterSpacing:'0.2em', color:'#9DD4D1', marginBottom:10 }}>PROJETS</div>
          </div>
          <div style={{ flex:1, overflowY:'auto', padding:'6px' }}>
            {loading && <div style={{ color:'rgba(255,255,255,0.4)', fontSize:11, padding:8 }}>Chargement…</div>}
            {projects.map(p => {
              const pt = tasks.filter(t => t.project_id === p.id)
              const avg = pt.length ? Math.round(pt.reduce((a,t)=>a+t.progress,0)/pt.length) : 0
              const active = p.id === selectedId
              return (
                <div key={p.id} onClick={() => selectProject(p.id)} style={{ padding:'9px 10px', borderRadius:3, cursor:'pointer', marginBottom:2, border:`1.5px solid ${active?'var(--accent-light)':'transparent'}`, background:active?'rgba(255,255,255,0.08)':'transparent' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:7 }}>
                    <div style={{ width:7,height:7,borderRadius:'50%',background:p.color,flexShrink:0 }}/>
                    <span style={{ fontWeight:500, fontSize:13, color:'#F2EDE4', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.name}</span>
                    <span onClick={e=>{e.stopPropagation();handleDeleteProject(p.id)}} style={{ color:'rgba(255,255,255,0.4)', fontSize:11, cursor:'pointer' }}>✕</span>
                  </div>
                  <div style={{ fontSize:11, color:'rgba(255,255,255,0.45)', marginTop:2, paddingLeft:14 }}>{p.client}</div>
                  <div style={{ display:'flex', alignItems:'center', gap:5, marginTop:3, paddingLeft:14 }}>
                    {(() => {
                      const start = parseDate(p.start_date).getTime()
                      const end = parseDate(p.end_date).getTime()
                      const now = Date.now()
                      const elapsed = Math.round(Math.max(0, Math.min(100, ((now - start) / (end - start)) * 100)))
                      const daysLeft = Math.max(0, Math.round((end - now) / 86400000))
                      const isLate = now > end
                      return <>
                        <span style={{ fontSize:11, color: isLate ? '#ff8080' : '#9DD4D1', fontFamily:'var(--font-display)', letterSpacing:'0.06em' }}>{elapsed}%</span>
                        <span style={{ fontSize:9, color:'rgba(255,255,255,0.2)' }}>·</span>
                        <span style={{ fontSize:10, color: isLate ? '#ff8080' : 'rgba(255,255,255,0.4)' }}>{isLate ? 'dépassé' : `J-${daysLeft}`}</span>
                        <span style={{ fontSize:9, color:'rgba(255,255,255,0.2)' }}>·</span>
                        <span style={{ fontSize:10, color:'rgba(255,255,255,0.35)' }}>{fmtShort(p.end_date)}</span>
                      </>
                    })()}
                  </div>
                  <div style={{ height:2, background:'rgba(255,255,255,0.08)', borderRadius:1, marginTop:5 }}>
                    <div style={{ height:'100%', width:`${avg}%`, background:p.color, borderRadius:1 }}/>
                  </div>
                </div>
              )
            })}
          </div>
          <div style={{ display:'flex', borderTop:'1px solid var(--border)', flexShrink:0, background:'var(--sidebar)' }}>
            {(['gantt','overview'] as View[]).map(v => (
              <div key={v} onClick={() => setView(v)} style={{ flex:1, textAlign:'center', padding:'10px 0', fontFamily:'var(--font-display)', fontSize:11, letterSpacing:'0.1em', cursor:'pointer', color:view===v?'var(--accent-light)':'rgba(255,255,255,0.4)', borderTop:`2px solid ${view===v?'var(--accent-light)':'transparent'}` }}>
                {v === 'gantt' ? 'GANTT' : 'ANNUEL'}
              </div>
            ))}
          </div>
        </div>

        {/* MAIN */}
        <div style={{ flex:1, display:'flex', overflow:'hidden', background:'var(--bg)' }}>
          {view === 'gantt' ? (
            <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
              {/* TOOLBAR */}
              <div style={{ display:'flex', alignItems:'center', gap:8, padding:'16px 22px', background:'var(--topbar)', borderBottom:'1px solid rgba(0,0,0,0.12)', flexShrink:0, flexWrap:'wrap' }}>
                <div style={{ fontFamily:'var(--font-display)', fontSize:32, letterSpacing:'0.08em', color:'white', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', minWidth:120 }}>
                  {selectedProject ? selectedProject.name : 'SÉLECTIONNER UN PROJET'}
                </div>
                <div style={{ display:'flex', borderRadius:2, overflow:'hidden', border:'1px solid rgba(255,255,255,0.3)', flexShrink:0 }}>
                  {(['day','week','month'] as ZoomLevel[]).map(z => (
                    <button key={z} onClick={()=>setZoom(z)} style={{ padding:'5px 10px', background:zoom===z?'white':'transparent', color:zoom===z?'#144947':'white', border:'none', cursor:'pointer', fontFamily:'var(--font-display)', fontSize:13, borderLeft:z!=='day'?'1px solid rgba(255,255,255,0.2)':'none' }}>
                      {z==='day'?'JOUR':z==='week'?'SEM.':'MOIS'}
                    </button>
                  ))}
                </div>
                <div style={{ display:'flex', alignItems:'center', gap:5, flexShrink:0 }}>
                  <button onClick={()=>shiftAnchor(-1)} style={navBtnStyle}>‹</button>
                  <div style={{ fontFamily:'var(--font-display)', fontSize:10, minWidth:140, textAlign:'center', color:'white' }}>{anchorLabel}</div>
                  <button onClick={()=>shiftAnchor(1)} style={navBtnStyle}>›</button>
                  <button onClick={()=>setAnchor(new Date())} style={{ ...navBtnStyle, width:'auto', padding:'0 8px', fontSize:9, fontFamily:'var(--font-display)' }}>AUJ.</button>
                  <button onMouseDown={e=>{e.stopPropagation();setGanttZoom(1)}} style={{ ...navBtnStyle, width:'auto', padding:'0 8px', fontSize:9, fontFamily:'var(--font-display)' }} title="Réinitialiser zoom">1:1</button>
                  <button onMouseDown={e=>{e.stopPropagation();setGanttZoom(z=>Math.min(3,z+0.25))}} style={{ ...navBtnStyle, fontSize:16 }} title="Zoom +">+</button>
                  <button onMouseDown={e=>{e.stopPropagation();setGanttZoom(z=>Math.max(0.3,z-0.25))}} style={{ ...navBtnStyle, fontSize:16 }} title="Zoom -">−</button>
                </div>
                {selectedProject && (
                  <>
                    <button onClick={addLane} style={{ ...btnStyle('ghost'), fontSize:11, flexShrink:0 }}>+ LIGNE</button>
                    <button onClick={()=>{ setLibraryTargetLane(null); setShowLibrary(v=>!v) }} style={{ ...btnStyle('primary'), background:showLibrary?'#9DD4D1':'white', flexShrink:0 }}>
                      {showLibrary?'✕':'+ BLOC'}
                    </button>
                  </>
                )}
              </div>

              <div style={{ flex:1, display:'flex', overflow:'hidden' }}>
                {/* GANTT */}
                <div ref={ganttRef} style={{ flex:1, overflowY:'auto', overflowX:'auto', position:'relative' }} onMouseDown={e => { onGanttMouseDown(e); if (!(e.target as HTMLElement).closest('.library-panel')) setShowLibrary(false) }}>
                  <div style={{ minWidth:zoom==='day'?columns.length*44*ganttZoom+160:Math.max(860, 860*ganttZoom), display:'flex', flexDirection:'column', position:'relative' }}>
                    {/* WEEK GROUP */}
                    {zoom==='day' && (
                      <div style={{ display:'flex', position:'sticky', top:0, zIndex:11, background:'rgba(0,0,0,0.1)', borderBottom:'1px solid rgba(255,255,255,0.08)' }}>
                        <div style={{ width:160, flexShrink:0, borderRight:'1px solid rgba(0,0,0,0.1)' }}/>
                        <div style={{ flex:1, display:'flex' }}>
                          {weekGroups.map((wg,i) => (
                            <div key={i} style={{ width:`${(wg.count/columns.length)*100}%`, height:20, display:'flex', alignItems:'center', paddingLeft:8, fontFamily:'var(--font-display)', fontSize:9, letterSpacing:'0.12em', color:'rgba(255,255,255,0.6)', borderLeft:i>0?'1px solid rgba(0,0,0,0.1)':'none', whiteSpace:'nowrap', overflow:'hidden' }}>{wg.label}</div>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* COL HEADER */}
                    <div style={{ display:'flex', position:'sticky', top:zoom==='day'?22:0, zIndex:10, background:'var(--topbar)', borderBottom:'1px solid rgba(0,0,0,0.12)' }}>
                      <div style={{ width:160, flexShrink:0, borderRight:'1px solid rgba(0,0,0,0.12)' }}>
                        <div style={{ height:48, display:'flex', alignItems:'center', padding:'0 14px', fontFamily:'var(--font-display)', fontSize:11, letterSpacing:'0.18em', color:'rgba(255,255,255,0.5)' }}>LIGNE / BLOC</div>
                      </div>
                      <div style={{ flex:1, display:'flex' }}>
                        {columns.map((col,i) => (
                          <div key={col.key} style={{ flex:1, height:48, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', fontFamily:'var(--font-display)', fontSize:zoom==='day'?15:13, color:col.isToday?'white':'rgba(255,255,255,0.65)', borderLeft:i>0?'1px solid rgba(0,0,0,0.1)':'none', background:col.isToday?'rgba(0,0,0,0.15)':'transparent', whiteSpace:'nowrap' }}>
                            <span style={{ fontWeight:col.isToday?700:400 }}>{col.label}</span>
                            {zoom!=='day'&&col.sublabel&&<span style={{ fontSize:9, opacity:0.5, marginTop:1 }}>{col.sublabel}</span>}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* LANES */}
                    {!selectedProject ? (
                      <div style={{ padding:'50px 0', textAlign:'center', color:'rgba(0,0,0,0.35)' }}>
                        <div style={{ fontFamily:'var(--font-display)', fontSize:18 }}>SÉLECTIONNER UN PROJET</div>
                      </div>
                    ) : sortedLanes.length === 0 ? (
                      <div style={{ padding:'50px 0', textAlign:'center', color:'rgba(0,0,0,0.35)' }}>
                        <div style={{ fontFamily:'var(--font-display)', fontSize:18, marginBottom:8 }}>AUCUNE LIGNE</div>
                        <div style={{ fontSize:12, marginBottom:16 }}>Crée une ligne puis ajoute des blocs</div>
                        <button onClick={addLane} style={btnStyle('primary')}>+ CRÉER UNE LIGNE</button>
                      </div>
                    ) : (
                      sortedLanes.map(lane => {
                        const laneTasks = projTasks.filter(t => t.lane_id === lane.id)
                        const isLaneDragging = draggingLaneId === lane.id
                        return (
                          <div key={lane.id} style={{ display:'flex', borderBottom:'1px solid rgba(0,0,0,0.08)', minHeight:62, opacity:isLaneDragging?0.5:1, transition:'opacity 0.1s' }}>
                            {/* LANE LABEL */}
                            <div style={{ width:160, flexShrink:0, background:'rgba(0,0,0,0.04)', borderRight:'1px solid rgba(0,0,0,0.08)', display:'flex', alignItems:'center', gap:6, padding:'0 10px', position:'sticky', left:0, zIndex:5 }}>
                              {/* DRAG HANDLE */}
                              <div
                                className="lane-handle"
                                onMouseDown={e => onLaneDragStart(e, lane.id, lane.sort_order)}
                                style={{ cursor:'grab', color:'rgba(0,0,0,0.3)', fontSize:14, flexShrink:0, userSelect:'none', padding:'4px 2px' }}
                                title="Glisser pour réordonner"
                              >≡</div>
                              {/* EDITABLE NAME */}
                              <input
                                value={lane.name}
                                onChange={e => renameLane(lane.id, e.target.value)}
                                style={{ background:'transparent', border:'none', outline:'none', color:'var(--text)', fontSize:13, fontWeight:500, fontFamily:'var(--font-body)', flex:1, cursor:'text' }}
                                onClick={e => e.stopPropagation()}
                              />
                              {/* ADD BLOCK TO THIS LANE */}
                              <button
                                onClick={e=>{ e.stopPropagation(); setLibraryTargetLane(lane.id); setShowLibrary(true) }}
                                style={{ background:'none', border:'none', color:'rgba(0,0,0,0.35)', cursor:'pointer', fontSize:16, lineHeight:1, flexShrink:0, padding:'2px 4px' }}
                                title="Ajouter un bloc"
                              >+</button>
                              {/* DELETE LANE */}
                              <button
                                onClick={e=>{ e.stopPropagation(); removeLane(lane.id) }}
                                style={{ background:'none', border:'none', color:'rgba(0,0,0,0.3)', cursor:'pointer', fontSize:12, lineHeight:1, flexShrink:0 }}
                              >✕</button>
                            </div>

                            {/* BARS AREA */}
                            <div className="bars-area" data-lane-id={lane.id} style={{ flex:1, position:'relative', minHeight:52, background: dropLaneHighlight===lane.id ? 'rgba(255,255,255,0.12)' : 'transparent', outline: dropLaneHighlight===lane.id ? '2px solid rgba(255,255,255,0.3)' : 'none', transition:'background 0.1s' }}>
                              {columns.map((col,i) => (
                                <div key={col.key} style={{ position:'absolute',top:0,bottom:0,left:`${(i/columns.length)*100}%`,width:`${100/columns.length}%`,background:col.isToday?'rgba(255,255,255,0.05)':'transparent',borderLeft:i>0?'1px solid rgba(255,255,255,0.05)':'none',pointerEvents:'none' }}/>
                              ))}
                              {todayPct>=0&&todayPct<=100&&(
                                <div style={{ position:'absolute',top:0,bottom:0,left:`${todayPct}%`,width:1,background:'rgba(0,0,0,0.15)',zIndex:4,pointerEvents:'none' }}/>
                              )}
                              {laneTasks.map(task => {
                                const l = Math.max(0, pctFromDate(task.start_date))
                                const w = Math.max(0.5, pctWidth(task.start_date, task.end_date))
                                const isSelected = selectedTaskIds.has(task.id)
                                return (
                                  <div
                                    key={task.id}
                                    className="gantt-bar"
                                    data-task-id={task.id}
                                    onMouseDown={e => { if (!(e.target as HTMLElement).classList.contains('resize-h')) onMouseDownBar(e, task.id, false) }}
                                    onClick={e => {
                                      e.stopPropagation()
                                      if (e.shiftKey) {
                                        setSelectedTaskIds(prev => { const n = new Set(prev); n.has(task.id)?n.delete(task.id):n.add(task.id); return n })
                                      } else {
                                        setSelectedTaskIds(new Set([task.id]))
                                      }
                                    }}
                                    onContextMenu={e => { e.preventDefault(); e.stopPropagation(); openEditTask(task) }}
                                    title={`${task.name}${task.progress > 0 ? ' · ' + task.progress + '%' : ''} | ${fmtShort(task.start_date)} → ${fmtShort(task.end_date)}`} style={{ position:'absolute', height:34, top:'50%', transform:'translateY(-50%)', left:`${l}%`, width:`${w}%`, minWidth:6, background:task.color, borderRadius:2, cursor:'grab', display:'flex', alignItems:'center', padding:'0 8px', fontSize:12, fontWeight:500, color:'white', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', userSelect:'none', zIndex:isSelected?3:2, textShadow:'0 1px 2px rgba(0,0,0,0.3)', outline:isSelected?'2px solid white':'none', boxShadow:isSelected?'0 0 0 2px rgba(255,255,255,0.4)':'none' }}
                                  >
                                    <div style={{ position:'absolute',left:0,bottom:0,height:3,width:`${task.progress}%`,background:'rgba(255,255,255,0.7)',borderRadius:'0 0 0 2px',pointerEvents:'none',zIndex:3 }}/>
                                    <span style={{ position:'relative',zIndex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:'calc(100% - 28px)' }}>{task.name}</span>
                                    {task.progress > 0 && w > 4 && <span style={{ position:'absolute', right:6, fontSize:9, opacity:0.75, zIndex:1, flexShrink:0 }}>{task.progress}%</span>}
                                    <div
                                      className="resize-h"
                                      onMouseDown={e=>{ e.stopPropagation(); onMouseDownBar(e, task.id, true) }}
                                      style={{ position:'absolute',right:0,top:0,bottom:0,width:8,cursor:'col-resize',background:'rgba(0,0,0,0.2)',borderRadius:'0 2px 2px 0' }}
                                    />
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>

                    {selectedProject && (
                      <div style={{ display:'flex', borderBottom:'1px solid rgba(255,255,255,0.04)', minHeight:44 }}>
                        <div style={{ width:160, flexShrink:0, borderRight:'1px solid rgba(255,255,255,0.06)', background:'var(--bg2)', display:'flex', alignItems:'center', padding:'0 10px', position:'sticky', left:0, zIndex:5 }}>
                          <button onMouseDown={e=>{e.stopPropagation();addLane()}} style={{ background:'none', border:'1px dashed rgba(0,0,0,0.2)', borderRadius:2, color:'rgba(0,0,0,0.4)', cursor:'pointer', fontSize:11, fontFamily:'var(--font-display)', letterSpacing:'0.1em', padding:'5px 10px', width:'100%' }}>+ LIGNE</button>
                        </div>
                        <div style={{ flex:1 }}/>
                      </div>
                    )}
                  {/* LASSO */}
                  {lasso && lasso.w > 5 && lasso.h > 5 && (
                    <div style={{ position:'absolute', left:lasso.x, top:lasso.y, width:lasso.w, height:lasso.h, border:'1.5px solid rgba(255,255,255,0.8)', background:'rgba(255,255,255,0.08)', pointerEvents:'none', zIndex:20, borderRadius:2 }}/>
                  )}
                </div>

                {/* LIBRARY PANEL */}
                {showLibrary && (
                  <div style={{ width:250, flexShrink:0, background:'var(--surface)', borderLeft:'1px solid var(--border)', overflowY:'auto', display:'flex', flexDirection:'column' }}>
                    <div style={{ padding:'12px 14px 8px', borderBottom:'1px solid var(--border)', position:'sticky', top:0, background:'var(--surface)', zIndex:5 }}>
                      <div style={{ fontFamily:'var(--font-display)', fontSize:11, letterSpacing:'0.18em', color:'#0E0D0B' }}>
                        {libraryTargetLane ? `→ ${lanes.find(l=>l.id===libraryTargetLane)?.name||'LIGNE'}` : 'AJOUTER UN BLOC'}
                      </div>
                      <div style={{ fontSize:10, color:'var(--text3)', marginTop:3 }}>Clic = ajouté à aujourd'hui</div>
                    </div>
                    <div style={{ padding:'8px' }}>
                      {BLOCK_LIBRARY.map(cat => (
                        <div key={cat.category} style={{ marginBottom:14 }}>
                          <div style={{ display:'flex', alignItems:'center', gap:6, padding:'3px 6px 6px' }}>
                            <div style={{ width:7,height:7,borderRadius:'50%',background:cat.color }}/>
                            <span style={{ fontFamily:'var(--font-display)', fontSize:10, letterSpacing:'0.15em', color:'rgba(255,255,255,0.5)' }}>{cat.category}</span>
                          </div>
                          {cat.blocks.map(block => (
                            <button key={block} onClick={() => addBlockFromLibrary(block, cat.color, cat.category)}
                              style={{ display:'flex', alignItems:'center', gap:7, padding:'7px 10px', background:'var(--bg2)', border:'1px solid transparent', borderRadius:3, cursor:'pointer', textAlign:'left', color:'#0E0D0B', fontSize:11, fontFamily:'var(--font-body)', width:'100%', marginBottom:2 }}
                              onMouseEnter={e=>{ e.currentTarget.style.background='rgba(255,255,255,0.13)'; e.currentTarget.style.borderColor=cat.color }}
                              onMouseLeave={e=>{ e.currentTarget.style.background='rgba(255,255,255,0.05)'; e.currentTarget.style.borderColor='transparent' }}
                            >
                              <div style={{ width:5,height:5,borderRadius:'50%',background:cat.color,flexShrink:0 }}/>
                              {block}
                              <span style={{ marginLeft:'auto', color:'rgba(255,255,255,0.2)', fontSize:14 }}>+</span>
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <OverviewPanel projects={projects} tasks={tasks} year={overviewYear} onYearChange={setOverviewYear} onSelectProject={id=>{selectProject(id);setView('gantt')}} />
          )}
        </div>
      </div>

      {/* PROJECT MODAL */}
      {showProjModal && (
        <Modal onClose={() => setShowProjModal(false)} title="NOUVEAU PROJET">
          <FormRow label="NOM"><input type="text" value={pName} onChange={e=>setPName(e.target.value)} autoFocus placeholder="ex. SALON M&O 2025"/></FormRow>
          <FormRow label="CLIENT"><input type="text" value={pClient} onChange={e=>setPClient(e.target.value)} placeholder="ex. Valentino"/></FormRow>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:14 }}>
            <FormRow label="DÉBUT"><input type="date" value={pStart} onChange={e=>setPStart(e.target.value)}/></FormRow>
            <FormRow label="FIN"><input type="date" value={pEnd} onChange={e=>setPEnd(e.target.value)}/></FormRow>
          </div>
          <FormRow label="COULEUR"><ColorPicker colors={PROJ_COLORS} selected={pColor} onSelect={setPColor}/></FormRow>
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:20 }}>
            <button onClick={()=>setShowProjModal(false)} style={btnStyle('ghost')}>Annuler</button>
            <button onClick={handleCreateProject} style={btnStyle('primary')}>CRÉER</button>
          </div>
        </Modal>
      )}

      {/* TASK EDIT MODAL */}
      {showTaskModal && editingTask && (
        <Modal onClose={() => setShowTaskModal(false)} title="MODIFIER LE BLOC">
          <FormRow label="NOM"><input type="text" value={tName} onChange={e=>setTName(e.target.value)} autoFocus/></FormRow>
          <FormRow label="LIGNE">
            <select value={tLane} onChange={e=>setTLane(e.target.value)}>
              {sortedLanes.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </FormRow>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:14 }}>
            <FormRow label="DÉBUT"><input type="date" value={tStart} onChange={e=>setTStart(e.target.value)}/></FormRow>
            <FormRow label="FIN"><input type="date" value={tEnd} onChange={e=>setTEnd(e.target.value)}/></FormRow>
          </div>
          <FormRow label="COULEUR"><ColorPicker colors={TASK_COLORS} selected={tColor} onSelect={setTColor}/></FormRow>
          <FormRow label={`AVANCEMENT · ${tProgress}%`}>
            <div style={{ display:'flex', gap:6, marginBottom:8 }}>
              {[0,25,50,75,100].map(v => (
                <button key={v} onMouseDown={e=>{e.stopPropagation();setTProgress(v)}} style={{ flex:1, padding:'6px 0', background: tProgress===v ? 'var(--accent)' : 'var(--bg2)', border:'1px solid var(--border)', borderRadius:2, color: tProgress===v ? 'var(--bg)' : 'var(--text)', cursor:'pointer', fontFamily:'var(--font-display)', fontSize:12, letterSpacing:'0.05em' }}>{v}%</button>
              ))}
            </div>
            <input type="range" min={0} max={100} value={tProgress} onChange={e=>setTProgress(Number(e.target.value))} style={{ width:'100%', accentColor:'#9DD4D1', cursor:'pointer' }}/>
          </FormRow>
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:20 }}>
            <button onClick={handleDeleteTask} style={{ ...btnStyle('ghost'), marginRight:'auto', color:'#ff8080', borderColor:'rgba(255,100,100,0.3)' }}>SUPPRIMER</button>
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
  const yS = new Date(year,0,1), yE = new Date(year,11,31)
  const total = (yE.getTime()-yS.getTime())/86400000+1
  const pct = (d:string) => Math.max(0,Math.min(100,((new Date(d+'T00:00:00').getTime()-yS.getTime())/86400000/total)*100))
  const todayPct = new Date().getFullYear()===year ? pct(toIso(new Date())) : -1
  const MS = ['JAN','FÉV','MAR','AVR','MAI','JUN','JUL','AOÛ','SEP','OCT','NOV','DÉC']
  return (
    <div style={{ flex:1, overflowY:'auto', padding:32, background:'var(--bg)' }}>
      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:24 }}>
        <button onClick={()=>onYearChange(year-1)} style={navBtnStyle}>‹</button>
        <div style={{ fontFamily:'var(--font-display)', fontSize:42, letterSpacing:'0.06em', color:'var(--text)' }}>VUE <span style={{color:'var(--accent)'}}>{year}</span></div>
        <button onClick={()=>onYearChange(year+1)} style={navBtnStyle}>›</button>
      </div>
      <div style={{ display:'flex', paddingLeft:212, marginBottom:10 }}>
        {MS.map(m=><div key={m} style={{ flex:1, fontFamily:'var(--font-display)', fontSize:14, letterSpacing:'0.1em', color:'var(--text2)', textAlign:'center' }}>{m}</div>)}
      </div>
      {projects.map(proj => {
        const pt = tasks.filter(t=>t.project_id===proj.id)
        return (
          <div key={proj.id} style={{ marginBottom:82 }}>
            <div onClick={()=>onSelectProject(proj.id)} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8, cursor:'pointer' }}>
              <div style={{ width:8,height:8,borderRadius:'50%',background:proj.color,flexShrink:0 }}/>
              <span style={{ fontFamily:'var(--font-display)', fontSize:20, letterSpacing:'0.1em', color:'var(--text)', fontWeight:600 }}>{proj.name}</span>
              <span style={{ fontSize:12, color:'rgba(255,255,255,0.5)' }}>{proj.client}</span>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:5 }}>
              <div style={{ width:170, flexShrink:0 }}/>
              <div style={{ flex:1, height:36, borderRadius:3, background:'rgba(255,255,255,0.06)', position:'relative', border:'1px solid rgba(255,255,255,0.08)' }}>
                {todayPct>=0&&<div style={{ position:'absolute',top:0,bottom:0,left:`${todayPct}%`,width:2,background:'rgba(255,255,255,0.6)',zIndex:3 }}/>}
                {pt.map(t=>{const l=pct(t.start_date),w=Math.max(0.3,pct(t.end_date)-l);return <div key={t.id} style={{ position:'absolute',height:'100%',left:`${l}%`,width:`${w}%`,background:proj.color,opacity:0.6,borderRadius:2 }}/>})}
              </div>
            </div>
            {pt.map(t=>{
              const l=pct(t.start_date),w=Math.max(0.3,pct(t.end_date)-l)
              return (
                <div key={t.id} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
                  <div style={{ width:210, flexShrink:0, fontSize:13, color:'var(--text2)', paddingLeft:16, fontWeight:500, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{t.name}</div>
                  <div style={{ flex:1, height:28, borderRadius:2, background:'rgba(255,255,255,0.05)', position:'relative', border:'1px solid rgba(255,255,255,0.06)' }}>
                    {todayPct>=0&&<div style={{ position:'absolute',top:0,bottom:0,left:`${todayPct}%`,width:1.5,background:'rgba(255,255,255,0.5)',zIndex:3 }}/>}
                    <div style={{ position:'absolute',height:'100%',left:`${l}%`,width:`${w}%`,background:proj.color,opacity:1,borderRadius:2,display:'flex',alignItems:'center',padding:'0 6px',overflow:'hidden' }}/>
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
      <div style={{ background:'var(--surface)',border:'1px solid var(--border)',borderRadius:4,width:440,maxWidth:'95vw',padding:26,position:'relative',maxHeight:'90vh',overflowY:'auto' }}>
        <button onClick={onClose} style={{ position:'absolute',top:12,right:12,background:'none',border:'none',color:'var(--text3)',fontSize:18,cursor:'pointer' }}>✕</button>
        <div style={{ fontFamily:'var(--font-display)',fontSize:20,letterSpacing:'0.1em',color:'var(--text)',marginBottom:20 }}>{title}</div>
        {children}
      </div>
    </div>
  )
}

function FormRow({ label, children }:{ label:string, children:React.ReactNode }) {
  return (
    <div style={{ marginBottom:13 }}>
      <label style={{ display:'block',fontFamily:'var(--font-display)',fontSize:10,letterSpacing:'0.18em',color:'var(--accent)',marginBottom:5 }}>{label}</label>
      {children}
    </div>
  )
}

function btnStyle(type:'primary'|'ghost'): React.CSSProperties {
  return { fontFamily:'var(--font-display)', fontSize:15, padding:'10px 20px', borderRadius:2, border:type==='ghost'?'1.5px solid rgba(255,255,255,0.5)':'none', background:type==='primary'?'white':'transparent', color:type==='primary'?'#144947':'white', cursor:'pointer', letterSpacing:'0.08em' }
}

const navBtnStyle: React.CSSProperties = { width:32, height:32, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(255,255,255,0.15)', border:'1px solid rgba(255,255,255,0.3)', borderRadius:2, cursor:'pointer', fontSize:17, color:'white' }
