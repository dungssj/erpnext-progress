import { FrappeApp } from 'frappe-js-sdk'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import 'dotenv/config'

/* ========= Helpers ========= */
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function stripHtml(html = '') {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

function sanitizeHtml(html = '') {
  return (html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
}

function chunk(arr, size = 200) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function addOneDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

function parseArgs(argv) {
  // Ví dụ:
  // node personal_report.js --email=nhi.nguyen@ --company="Công ty F" --from=2025-08-01 --to=2025-08-08 --status=Open,Completed --leaf --latest --kw="mẫu"
  const f = {}
  argv.forEach((a) => {
    const [kRaw, ...rest] = a.replace(/^--/, '').split('=')
    const k = kRaw.trim()
    const v = rest.join('=')
    switch (k) {
      case 'email':     f.email = v?.trim(); break
      case 'from':
      case 'from_date': f.from_date = v; break
      case 'to':
      case 'to_date':   f.to_date = v; break
      case 'project':   f.project = v; break
      case 'company':   f.company = v; break
      case 'kw':
      case 'keyword':   f.keyword = v; break
      case 'status':
      case 'task_status': f.task_status = v ? v.split(',').map(s => s.trim()).filter(Boolean) : undefined; break
      case 'leaf':      f.leaf_only = true; break
      case 'latest':    f.latest_only = true; break
    }
  })
  if (!f.email) throw new Error('Thiếu --email (ví dụ: --email=nhi.nguyen@abc.com)')
  if (f.leaf_only === undefined) f.leaf_only = false
  if (f.latest_only === undefined) f.latest_only = false
  if (!f.task_status) f.task_status = ['Open','Working','Completed','Overdue','Pending Review']
  return f
}

function emailInJsonList(raw, email) {
  if (!raw) return false
  try {
    // raw có thể là string JSON hoặc object/array (tuỳ site)
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!Array.isArray(arr)) return false
    return arr.map(x => String(x).trim().toLowerCase()).includes(email.trim().toLowerCase())
  } catch {
    return false
  }
}

/* ========= Core ========= */
async function main(filters) {
  const FRAPPE_URL = process.env.FRAPPE_URL
  const API_KEY = process.env.FRAPPE_API_KEY
  const API_SECRET = process.env.FRAPPE_API_SECRET
  if (!FRAPPE_URL || !API_KEY || !API_SECRET) {
    throw new Error('Thiếu FRAPPE_URL / FRAPPE_API_KEY / FRAPPE_API_SECRET trong .env')
  }

  const app = new FrappeApp(FRAPPE_URL, {
    useToken: true,
    token: () => `${API_KEY}:${API_SECRET}`,
    type: 'token'
  })
  const db = app.db()

  /* 1) Xác định tập Project theo --project/--company (nếu có) */
  const projectMap = {}
  const targetProjectIdSet = new Set()

  if (filters.project) targetProjectIdSet.add(filters.project)

  if (filters.company) {
    const companyProjects = await db.getDocList('Project', {
      fields: ['name','project_name','status','company','percent_complete'],
      filters: [['company','=', filters.company]],
      limit: 10000
    })
    for (const p of companyProjects) {
      targetProjectIdSet.add(p.name)
      projectMap[p.name] = p
    }
  }

  /* 2) LẤY TẤT CẢ TASK người này phụ trách (dựa vào custom_nguoi_phu_trach) */
  const taskFilters = []
  if (targetProjectIdSet.size) {
    taskFilters.push(['project', 'in', [...targetProjectIdSet]])
  }
  // lọc sơ bộ bằng LIKE để giảm tải, xác thực kỹ bằng parse JSON bên dưới
  taskFilters.push(['custom_nguoi_phu_trach', 'like', `%${filters.email}%`])

  let allTasks = []
  // phân trang theo project-chunk để an toàn
  for (const part of chunk(taskFilters.find(f => f[0]==='project') ? [...targetProjectIdSet] : [null], 50)) {
    const filtersForCall = taskFilters.slice()
    if (part[0] !== null) {
      // thay thế 'project in' theo part
      filtersForCall.splice(0, filtersForCall.length,
        ['project','in', part],
        ['custom_nguoi_phu_trach', 'like', `%${filters.email}%`]
      )
    }
    const batch = await db.getDocList('Task', {
      fields: ['name','subject','status','progress','priority','is_group','project','parent_task','lft','rgt','custom_nguoi_phu_trach'],
      filters: filtersForCall,
      limit: 10000
    })
    allTasks = allTasks.concat(batch)
  }

  // Nếu không truyền project/company → query một phát
  if (!allTasks.length && !targetProjectIdSet.size) {
    allTasks = await db.getDocList('Task', {
      fields: ['name','subject','status','progress','priority','is_group','project','parent_task','lft','rgt','custom_nguoi_phu_trach'],
      filters: [['custom_nguoi_phu_trach', 'like', `%${filters.email}%`]],
      limit: 10000
    })
  }

  // Xác thực đúng email ∈ custom_nguoi_phu_trach (JSON)
  allTasks = allTasks.filter(t => emailInJsonList(t.custom_nguoi_phu_trach, filters.email))

  // Áp filter status / leaf_only nếu có
  if (filters.task_status?.length) {
    const set = new Set(filters.task_status.map(s => s.toLowerCase()))
    allTasks = allTasks.filter(t => set.has(String(t.status || '').toLowerCase()))
  }
  if (filters.leaf_only) {
    allTasks = allTasks.filter(t => !Number(t.is_group || 0))
  }

  if (!allTasks.length) {
    console.log(`Không có task nào mà ${filters.email} phụ trách theo filter hiện tại.`)
    process.exit(0)
  }

  // Bổ sung projectIds từ tasks (đồng thời nạp projectMap còn thiếu)
  const projectIds = [...new Set(allTasks.map(t => t.project).filter(Boolean))]
  const missingProjects = projectIds.filter(pid => !projectMap[pid])
  if (missingProjects.length) {
    for (const part of chunk(missingProjects)) {
      const partProjects = await db.getDocList('Project', {
        fields: ['name','project_name','status','company','percent_complete'],
        filters: [['name','in', part]],
        limit: part.length,
      })
      for (const p of partProjects) projectMap[p.name] = p
    }
  }
  // Nếu có filter company mà chưa dùng từ đầu, lọc lại tasks theo company của project
  if (filters.company) {
    allTasks = allTasks.filter(t => (projectMap[t.project]?.company || '') === filters.company)
  }

  /* 3) LẤY COMMENT của những Task đã lọc (không giới hạn người viết) */
  const taskNames = [...new Set(allTasks.map(t => t.name))]
  let filteredComments = []
  for (const part of chunk(taskNames, 400)) {
    const commentFilters = [
      ['reference_doctype', '=', 'Task'],
      ['reference_name', 'in', part],
      ['comment_type', '=', 'Comment'],
      ['comment_email', '=', filters.email] 
    ]
    if (filters.from_date) commentFilters.push(['creation', '>=', filters.from_date])
    if (filters.to_date)   commentFilters.push(['creation', '<', addOneDay(filters.to_date)])

    const batch = await db.getDocList('Comment', {
      fields: ['name','creation','owner','comment_type','content','reference_name'],
      filters: commentFilters,
      orderBy: { field: 'creation', order: 'asc' },
      limit: 10000,
    })
    filteredComments = filteredComments.concat(
      batch.filter(c => String(c.comment_type || '').toLowerCase() === 'comment')
    )
  }

  // Lọc keyword (nếu có) trên nội dung comment (text thuần)
  if (filters.keyword) {
    const kw = filters.keyword.toLowerCase()
    filteredComments = filteredComments.filter(c => stripHtml(c.content).toLowerCase().includes(kw))
  }

  // latest_only: mỗi task 1 comment mới nhất
  if (filters.latest_only) {
    const latest = {}
    for (const c of filteredComments) {
      const k = c.reference_name
      if (!latest[k] || c.creation > latest[k].creation) latest[k] = c
    }
    filteredComments = Object.values(latest)
  }

  /* 4) Gom comment theo Task */
  const commentsByTask = new Map()
  for (const c of filteredComments) {
    const arr = commentsByTask.get(c.reference_name) || []
    arr.push(c)
    commentsByTask.set(c.reference_name, arr)
  }

  /* 5) Build cây Task cha–con trong từng Project */
  const tasksByProject = new Map()
  for (const t of allTasks) {
    const arr = tasksByProject.get(t.project) || []
    arr.push(t)
    tasksByProject.set(t.project, arr)
  }

  function sortTasksForProject(list) {
    const hasTree = list.some(t => typeof t.lft === 'number' && t.lft !== null)
    if (hasTree) return list.slice().sort((a, b) => (a.lft ?? 0) - (b.lft ?? 0))
    return list.slice().sort((a, b) => (a.subject || '').localeCompare(b.subject || ''))
  }

  function buildTaskTreeForProject(taskList) {
    const nodes = new Map()
    const childrenMap = new Map()

    for (const t of taskList) {
      nodes.set(t.name, {
        task_id: t.name,
        task_subject: t.subject,
        task_status: t.status,
        task_progress: t.progress ?? null,
        task_priority: t.priority ?? null,
        is_group: !!Number(t.is_group || 0),
        comments: [],
        children: [],
      })
    }

    for (const t of taskList) {
      const node = nodes.get(t.name)
      const cmts = (commentsByTask.get(t.name) || [])
        .slice()
        .sort((a, b) => b.creation.localeCompare(a.creation)) // mới nhất lên đầu
      node.comments = cmts.map(c => ({
        comment_time: c.creation,
        comment_owner: c.owner,
        comment_html: sanitizeHtml(c.content),
      }))
    }

    for (const t of taskList) {
      const parent = t.parent_task
      if (parent && nodes.has(parent)) {
        const arr = childrenMap.get(parent) || []
        arr.push(nodes.get(t.name))
        childrenMap.set(parent, arr)
      }
    }

    for (const [p, kids] of childrenMap.entries()) {
      const parentNode = nodes.get(p)
      const orderedKids = sortTasksForProject(
        kids.map(k => ({ ...taskList.find(t => t.name === k.task_id), __node: k }))
      ).map(x => x.__node)
      parentNode.children = orderedKids
      if (orderedKids.length > 0) parentNode.is_group = true
    }

    const taskNameSet = new Set(taskList.map(t => t.name))
    const roots = []
    for (const t of taskList) {
      const isRoot = !t.parent_task || !taskNameSet.has(t.parent_task)
      if (isRoot) roots.push(nodes.get(t.name))
    }

    const orderedRoots = sortTasksForProject(
      roots.map(r => ({ ...taskList.find(t => t.name === r.task_id), __node: r }))
    ).map(x => x.__node)

    return orderedRoots
  }

  /* 6) GHÉP Project → Task Tree */
  const sortedProjectIds = [...tasksByProject.keys()].sort((a, b) => {
    const pa = (projectMap[a] || {}).project_name || ''
    const pb = (projectMap[b] || {}).project_name || ''
    return pa.localeCompare(pb)
  })

  const tree = []
  for (const pid of sortedProjectIds) {
    const p = projectMap[pid]
    if (!p) continue
    const taskList = tasksByProject.get(pid) || []
    const taskTree = buildTaskTreeForProject(taskList)
    tree.push({
      project_id: p.name,
      project_name: p.project_name,
      project_status: p.status,
      project_company: p.company,
      project_percent: p.percent_complete ?? null,
      responsible_email: filters.email,
      tasks: taskTree,
    })
  }

  /* 7) Xuất JSON */
  const outDir = path.resolve(__dirname, 'out')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const safeEmail = filters.email.replace(/[^a-zA-Z0-9]/g,'_')
  const jsonOut = path.join(outDir, `personal_report_by_responsible_${safeEmail}_${Date.now()}.json`)
  fs.writeFileSync(jsonOut, JSON.stringify(tree, null, 2), 'utf8')
  console.log(`✔ Đã xuất JSON cá nhân (theo phụ trách): ${jsonOut}`)
}

/* ========= Run ========= */
const filters = parseArgs(process.argv.slice(2))
main(filters).catch(err => {
  console.error('Lỗi:', err)
  process.exit(1)
})