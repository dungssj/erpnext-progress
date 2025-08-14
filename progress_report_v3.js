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
  // Giữ layout; bỏ script/style để render HTML an toàn
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
  // ví dụ: --project=PROJ-0019 --company="Công ty F" --from=2025-08-01 --to=2025-08-08 --status=Open,Completed --leaf --latest --kw="gửi hàng"
  const f = {}
  argv.forEach((a) => {
    const [kRaw, ...rest] = a.replace(/^--/, '').split('=')
    const k = kRaw.trim()
    const v = rest.join('=')
    switch (k) {
      case 'from':
      case 'from_date': f.from_date = v; break
      case 'to':
      case 'to_date':   f.to_date = v; break
      case 'project':   f.project = v; break
      case 'company':   f.company = v; break
      case 'owner':
      case 'comment_owner': f.comment_owner = v; break
      case 'kw':
      case 'keyword':   f.keyword = v; break
      case 'status':
      case 'task_status': f.task_status = v ? v.split(',').map(s => s.trim()).filter(Boolean) : undefined; break
      case 'leaf':      f.leaf_only = true; break   // nếu muốn chỉ lá, bật cờ này
      case 'latest':    f.latest_only = true; break // nếu muốn mỗi task 1 comment mới nhất
    }
  })
  if (f.leaf_only === undefined) f.leaf_only = false
  if (f.latest_only === undefined) f.latest_only = false
  if (!f.task_status) f.task_status = ['Open','Working','Completed','Overdue','Pending Review']
  return f
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

  /* 1) LẤY COMMENT TRƯỚC (comment_type = 'Comment', reference_doctype = 'Task') */
  const commentFilters = [
    ['reference_doctype', '=', 'Task'],
    ['comment_type', '=', 'Comment'],
  ]
  if (filters.from_date) commentFilters.push(['creation', '>=', filters.from_date])
  if (filters.to_date)   commentFilters.push(['creation', '<', addOneDay(filters.to_date)])
  if (filters.comment_owner) commentFilters.push(['owner', '=', filters.comment_owner])

  let comments = await db.getDocList('Comment', {
    fields: ['name','creation','owner','comment_type','content','reference_name'],
    filters: commentFilters,
    orderBy: { field: 'creation', order: 'asc' },
    limit: 10000,
  })
  comments = comments.filter(c => String(c.comment_type || '').toLowerCase() === 'comment')

  /* 2) LẤY TASK cho các comment (để biết project phát sinh từ comment) */
  const taskMap = {}
  const commentTaskNames = [...new Set(comments.map(c => c.reference_name).filter(Boolean))]
  if (commentTaskNames.length) {
    for (const part of chunk(commentTaskNames)) {
      const partTasks = await db.getDocList('Task', {
        fields: ['name','subject','status','progress','priority','is_group','project','parent_task','lft','rgt'],
        filters: [['name','in', part]],
        limit: part.length,
      })
      for (const t of partTasks) taskMap[t.name] = t
    }
  }

  // Loại orphan sớm
  let filteredComments = comments.filter(c => taskMap[c.reference_name])

  /* 3) XÁC ĐỊNH PROJECT MỤC TIÊU & NẠP PROJECT */
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

  for (const c of filteredComments) {
    const pid = taskMap[c.reference_name]?.project
    if (pid) targetProjectIdSet.add(pid)
  }

  const projectIds = [...targetProjectIdSet]
  if (!projectIds.length) {
    console.log('Không xác định được Project mục tiêu (không có comment và không truyền --project/--company).')
    process.exit(0)
  }

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

  // Giới hạn comment về các project mục tiêu
  filteredComments = filteredComments.filter(c => {
    const pid = taskMap[c.reference_name]?.project
    return pid && targetProjectIdSet.has(pid)
  })

  /* 4) LẤY TẤT CẢ TASK CỦA PROJECT MỤC TIÊU (kể cả không có comment) */
  let allTasks = []
  for (const part of chunk(projectIds, 50)) {
    const partTasks = await db.getDocList('Task', {
      fields: ['name','subject','status','progress','priority','is_group','project','parent_task','lft','rgt'],
      filters: [['project','in', part]],
      limit: 10000
    })
    allTasks = allTasks.concat(partTasks)
  }

  // Áp filter status / leaf_only lên TASK (nếu có)
  if (filters.task_status && filters.task_status.length) {
    const set = new Set(filters.task_status.map(s => s.toLowerCase()))
    allTasks = allTasks.filter(t => set.has(String(t.status || '').toLowerCase()))
  }
  if (filters.leaf_only) {
    allTasks = allTasks.filter(t => !Number(t.is_group || 0))
  }

  // Cập nhật taskMap để chứa cả task không có comment
  for (const t of allTasks) taskMap[t.name] = t

  /* 5) Áp filter keyword trên COMMENT (task giữ nguyên) */
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

  /* 6) GOM COMMENT THEO TASK */
  const commentsByTask = new Map()
  for (const c of filteredComments) {
    const arr = commentsByTask.get(c.reference_name) || []
    arr.push(c)
    commentsByTask.set(c.reference_name, arr)
  }

  /* 7) XÂY CÂY TASK CHA–CON TRONG MỖI PROJECT */
  // a) Group task theo project
  const tasksByProject = new Map()
  for (const t of allTasks) {
    const arr = tasksByProject.get(t.project) || []
    arr.push(t)
    tasksByProject.set(t.project, arr)
  }

  // b) Với mỗi project: build map node, link children theo parent_task
  function sortTasksForProject(list) {
    // Ưu tiên sort theo lft nếu có, fallback subject
    const hasTree = list.some(t => typeof t.lft === 'number' && t.lft !== null)
    if (hasTree) {
      return list.slice().sort((a, b) => (a.lft ?? 0) - (b.lft ?? 0))
    }
    return list.slice().sort((a, b) => (a.subject || '').localeCompare(b.subject || ''))
  }

  function buildTaskTreeForProject(taskList) {
    const nodes = new Map() // name -> node
    const childrenMap = new Map() // parent -> [child nodes]

    // Tạo node rỗng ban đầu
    for (const t of taskList) {
      nodes.set(t.name, {
        task_id: t.name,
        task_subject: t.subject,
        task_status: t.status,
        task_progress: t.progress ?? null,
        task_priority: t.priority ?? null,
        comments: [],   // sẽ gắn ngay dưới
        children: [],   // sẽ gắn sau
      })
    }

    // Gắn comment vào đúng node
    for (const t of taskList) {
      const node = nodes.get(t.name)
      const cmts = (commentsByTask.get(t.name) || []).slice()
        .sort((a, b) => b.creation.localeCompare(a.creation))
      node.comments = cmts.map(c => ({
        comment_time: c.creation,
        comment_owner: c.owner,
        comment_html: sanitizeHtml(c.content),
        // comment_plain: stripHtml(c.content), // nếu muốn thêm text
      }))
    }

    // Lập map children theo parent_task
    for (const t of taskList) {
      const parent = t.parent_task
      if (parent && nodes.has(parent)) {
        const arr = childrenMap.get(parent) || []
        arr.push(nodes.get(t.name))
        childrenMap.set(parent, arr)
      }
    }

    // Điền children vào node cha
    for (const [p, kids] of childrenMap.entries()) {
      const parentNode = nodes.get(p)
      // sắp xếp children theo lft/subject như hàm sort
      const orderedKids = sortTasksForProject(
        kids.map(k => ({ ...taskList.find(t => t.name === k.task_id), __node: k }))
      ).map(x => x.__node)
      parentNode.children = orderedKids
    }

    // Xác định roots: task không có parent_task hoặc parent không thuộc cùng project/filter
    const taskNameSet = new Set(taskList.map(t => t.name))
    const roots = []
    for (const t of taskList) {
      const isRoot = !t.parent_task || !taskNameSet.has(t.parent_task)
      if (isRoot) roots.push(nodes.get(t.name))
    }

    // Sort root nodes giống quy tắc
    const orderedRoots = sortTasksForProject(
      roots.map(r => ({ ...taskList.find(t => t.name === r.task_id), __node: r }))
    ).map(x => x.__node)

    return orderedRoots
  }

  /* 8) GHÉP PROJECT → TASK TREE */
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
      tasks: taskTree, // cây cha–con
    })
  }

  /* 9) Xuất JSON */
  const outDir = path.resolve(__dirname, 'out')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const jsonOut = path.join(outDir, `progress_tree_${Date.now()}.json`)
  fs.writeFileSync(jsonOut, JSON.stringify(tree, null, 2), 'utf8')
  console.log(`✔ Đã xuất JSON: ${jsonOut}`)
}

/* ========= Run ========= */
const filters = parseArgs(process.argv.slice(2))
main(filters).catch(err => {
  console.error('Lỗi:', err)
  process.exit(1)
})