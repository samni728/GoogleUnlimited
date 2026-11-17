"use strict";

const $ = id => document.getElementById(id);
let csrf = "";
let currentStatus = null;
let browserDirectory = "";
let selectedFile = "";
let modalKind = "directory";
let selectedSourceId = "";
let showHiddenRecords = false;
let showCompletedSources = false;
const expandedEventSources = new Set();
const expandedAlbumSources = new Set();
const expandedReviewSources = new Set();
const reviewCache = new Map();
const scanRequestSources = new Set();
const albumDrafts = new Map();
let progressEndpointMissing = false;
let pageOffset = 0;
const pageSize = 100;

function humanSize(n) {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, value = Number(n);
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return value.toFixed(i ? 1 : 0) + " " + units[i];
}
function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = String(content);
  return node;
}
function clear(node) { node.replaceChildren(); }
function notice(message, ok = false) {
  const node = $("notice");
  node.hidden = !message;
  node.textContent = message || "";
  node.className = ok ? "notice ok" : "notice";
  if (message) window.scrollTo({top: 0, behavior: "smooth"});
}
async function get(url) {
  const response = await fetch(url, {cache: "no-store"});
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}
async function post(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json", "X-GU-CSRF": csrf},
    body: JSON.stringify(payload)
  });
  const output = await response.json();
  if (!response.ok) throw new Error(output.error || "操作失败");
  return output;
}
async function action(url, payload, message = "") {
  try {
    await post(url, payload);
    if (message) notice(message, true);
  } catch (error) {
    notice(error.message);
  }
  await refresh();
}

function collapseHiddenSourceDetails(sourceId) {
  // Removing/hiding a source must also clear previously expanded DOM tables.
  // Otherwise its rows would remain visible until the user reloads the page.
  if (selectedSourceId === String(sourceId)) {
    selectedSourceId = "";
    $("index-details").open = false;
    $("index-summary").textContent = "目录明细已收起。选择可见来源后按需展开。";
    $("folders-list").replaceChildren();
  }
  $("jobs-details").open = false;
  $("jobs-body").replaceChildren();
  expandedReviewSources.delete(Number(sourceId));
  reviewCache.delete(Number(sourceId));
}
const statusText = {
  queued: "等待上传", starting: "准备中", hashing: "计算文件信息",
  checking: "检查云端", uploading: "正在上传", completed: "处理完成",
  api_accepted: "API 已接收",
  duplicate: "已去重", retrying: "等待重试", failed: "上传失败",
  interrupted: "中断待人工核对", paused: "来源已暂停"
};

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return "暂不可估算";
  let value = Math.max(0, Math.round(Number(seconds)));
  if (value < 60) return value + " 秒";
  const minutes = Math.floor(value / 60);
  const remainder = value % 60;
  if (minutes < 60) return minutes + " 分" + (remainder ? remainder + " 秒" : "");
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return hours + " 小时" + (remainingMinutes ? remainingMinutes + " 分" : "");
}

function formatTimestamp(value) {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value).replace("T", " ") :
    date.toLocaleString("zh-CN", {hour12: false});
}

function renderUploadProgress(progress) {
  if (!progress || !progress.queue) return;
  const queue = progress.queue;
  const percent = Math.max(0, Math.min(100, Number(queue.percent) || 0));
  $("task-percent").textContent = percent + "%";
  $("task-bar").style.width = percent + "%";
  $("task-progress-count").textContent =
    (queue.done || 0) + " / " + (queue.total || 0) + " 项已完成 · " +
    (queue.pending_review || 0) + " 项待确认";

  const dataPercent = Math.max(0, Math.min(100, Number(queue.data_percent) || 0));
  $("queue-data-percent").textContent = dataPercent + "%";
  $("queue-data-count").textContent = humanSize(queue.data_done_bytes) + " / " +
    humanSize(queue.data_total_bytes);
  $("queue-data-bar").style.width = dataPercent + "%";

  const last = progress.last_completed;
  $("last-completed-name").textContent = last?.file_name || "暂无已完成文件";
  $("last-completed-meta").textContent = last
    ? humanSize(last.bytes) + " · " + formatTimestamp(last.completed_at) + " · API 已接收"
    : "完成第一个文件后，这里会显示文件名、大小和完成时间";

  const current = progress.current;
  if (!current) {
    $("upload-current-name").textContent = "当前没有文件正在处理";
    $("upload-current-state").textContent = "等待队列任务";
    $("upload-current-percent").textContent = "—";
    $("upload-current-bar").style.width = "0%";
    $("upload-current-bytes").textContent = "—";
    $("upload-current-speed").textContent = "—";
    $("upload-current-elapsed").textContent = "—";
    $("upload-current-eta").textContent = "—";
  } else {
    $("upload-current-name").textContent = current.file_name || "文件名未知";
    $("upload-current-state").textContent =
      (statusText[current.status] || current.status || "处理中") +
      (current.attempt > 1 ? " · 第 " + current.attempt + " 次尝试" : "");
    $("upload-current-percent").textContent =
      current.percent == null ? "准备中" : current.percent + "%";
    $("upload-current-bar").style.width =
      current.percent == null ? "0%" : Math.max(0, Math.min(100, current.percent)) + "%";
    $("upload-current-bytes").textContent =
      humanSize(current.bytes_uploaded) + " / " + humanSize(current.bytes_total);
    $("upload-current-speed").textContent = current.speed_bps > 0
      ? humanSize(current.speed_bps) + "/s" : "正在采集实际速度";
    $("upload-current-elapsed").textContent = formatDuration(current.elapsed_seconds);
    $("upload-current-eta").textContent = current.eta_seconds != null
      ? formatDuration(current.eta_seconds)
      : (current.status === "uploading" ? "正在采集速度" : "等待进入上传阶段");
  }

  $("upload-average-time").textContent = queue.average_file_seconds == null
    ? "样本不足" : formatDuration(queue.average_file_seconds) +
      " / 文件（最近 " + queue.average_sample_count + " 个）";
  $("upload-queue-eta").textContent = queue.eta_seconds != null
    ? formatDuration(queue.eta_seconds)
    : (queue.uploadable_remaining === 0 ? "暂无已确认待上传任务" :
      (queue.average_sample_count < 3 ? "至少完成 3 个文件后估算" : "当前无法估算"));
  $("upload-pending-review").textContent =
    (queue.pending_review || 0) + " 项等待人工确认，不计入上传队列 ETA";
}

async function refreshProgress() {
  try {
    const progress = await get("/api/progress");
    renderUploadProgress(progress);
    progressEndpointMissing = false;
  } catch (error) {
    if (!progressEndpointMissing) {
      $("upload-current-state").textContent = "实时进度接口将在本地服务更新后启用";
      progressEndpointMissing = true;
    }
  }
}

function renderScanPreview(source, container, jobs, total) {
  clear(container);
  const pending = Number(source.pending_review_count) || 0;
  const changed = Number(source.changed_count) || 0;
  const intro = element("div", "scan-preview-summary",
    "待确认 " + pending + " 项 · " + humanSize(source.pending_review_bytes) +
    (changed ? " · 内容变化 " + changed + " 项" : ""));
  container.appendChild(intro);
  const report = currentStatus?.last_scan_report;
  const sourceReport = report && report.source_ids?.length === 1 &&
    Number(report.source_ids[0]) === Number(source.id) ? report : null;
  if (sourceReport) {
    const stats = element("div", "scan-report-grid");
    const values = [
      ["新增", sourceReport.new], ["内容变化", sourceReport.changed],
      ["已存在", sourceReport.existing], ["重复", sourceReport.duplicate],
      ["不可用来源", sourceReport.unavailable], ["不稳定文件", sourceReport.unstable],
      ["本地缺失", sourceReport.missing],
    ];
    for (const [label, value] of values) {
      const cell = element("div", "scan-report-stat");
      cell.append(element("small", null, label), element("strong", null, Number(value) || 0));
      stats.appendChild(cell);
    }
    container.appendChild(stats);
    if (sourceReport.error) {
      container.appendChild(element("div", "scan-preview-note", sourceReport.error));
    }
  }
  if (!source.album_confirmed) {
    container.appendChild(element("div", "scan-preview-note",
      "请先在“上传前设置”中保存并确认目标相册，再选择画质。扫描不会自动上传。"));
  }
  if (!jobs.length) {
    container.appendChild(element("div", "empty", pending
      ? "正在整理扫描结果，请稍后刷新。" : "没有发现新增或变化文件；原有上传记录保持不变。"));
    return;
  }

  const selection = element("div", "scan-selection-head");
  const selectAllLabel = element("label", "scan-select-all");
  const selectAll = element("input");
  selectAll.type = "checkbox";
  selectAllLabel.append(selectAll, element("span", null, "全选当前列表"));
  selection.appendChild(selectAllLabel);
  const selectedSummary = element("span", "scan-selected-summary", "已选 0 项");
  selection.appendChild(selectedSummary);
  container.appendChild(selection);

  const list = element("div", "scan-review-list");
  const checks = [];
  for (const job of jobs) {
    const item = element("label", "scan-review-item");
    const check = element("input");
    check.type = "checkbox";
    check.dataset.jobId = String(job.id);
    check.dataset.bytes = String(job.bytes || 0);
    checks.push(check);
    const fileInfo = element("span", "scan-review-file");
    fileInfo.appendChild(element("strong", null, job.name));
    fileInfo.appendChild(element("small", null,
      (job.change_kind === "changed" ? "内容已变化" : "新增文件") +
      " · " + humanSize(job.bytes) + " · " + (job.media_kind === "video" ? "视频" : "照片")));
    item.append(check, fileInfo);
    list.appendChild(item);
  }
  container.appendChild(list);

  if (total > jobs.length) {
    container.appendChild(element("div", "scan-preview-note",
      "当前显示前 " + jobs.length + " 项，共 " + total +
      " 项；确认本批后可继续确认下一批，单次最多 500 项。"));
  }

  const actions = element("div", "scan-preview-actions");
  const confirmButton = element("button", "btn primary",
    currentStatus?.auto_sync_enabled && source.upload_ready
      ? "确认所选并开始上传" : "确认所选并加入队列");
  confirmButton.type = "button";
  confirmButton.disabled = !source.album_confirmed;
  const updateSelection = () => {
    const selected = checks.filter(check => check.checked);
    const bytes = selected.reduce((sum, check) => sum + Number(check.dataset.bytes || 0), 0);
    selectedSummary.textContent = "已选 " + selected.length + " 项 · " + humanSize(bytes);
    confirmButton.disabled = !source.album_confirmed || selected.length === 0;
    selectAll.checked = selected.length === checks.length && checks.length > 0;
    selectAll.indeterminate = selected.length > 0 && selected.length < checks.length;
  };
  selectAll.addEventListener("change", () => {
    for (const check of checks) check.checked = selectAll.checked;
    updateSelection();
  });
  for (const check of checks) check.addEventListener("change", updateSelection);
  confirmButton.addEventListener("click", async () => {
    const selected = checks.filter(check => check.checked).map(check => Number(check.dataset.jobId));
    if (!selected.length) return;
    const totalBytes = checks.filter(check => check.checked)
      .reduce((sum, check) => sum + Number(check.dataset.bytes || 0), 0);
    const quality = source.upload_quality === "original"
      ? "Original quality（原始画质）" : "Storage saver（节省空间）";
    const startNow = !!currentStatus?.auto_sync_enabled && !!source.upload_ready;
    const message = "确认将 " + selected.length + " 个文件（" + humanSize(totalBytes) +
      "）加入上传队列？\n目标相册：" + source.album_name +
      "\n上传画质：" + quality +
      (startNow ? "\n全局与来源同步均已开启，确认后将开始上传。" :
        "\n当前同步许可未全部开启，只会加入队列，不会立即上传。");
    if (!confirm(message)) return;
    confirmButton.disabled = true;
    try {
      const result = await post("/api/source/scan/confirm", {
        id: source.id, job_ids: selected
      });
      reviewCache.delete(source.id);
      notice("已确认 " + result.confirmation.confirmed_count + " 个文件，" +
        humanSize(result.confirmation.confirmed_bytes) +
        (startNow ? "；已交给上传队列处理。" : "；已加入队列，等待同步开关允许。"), true);
      await refresh();
    } catch (error) {
      confirmButton.disabled = false;
      notice(error.message);
    }
  });
  actions.appendChild(selectedSummary);
  actions.appendChild(confirmButton);
  container.appendChild(actions);
  updateSelection();
}

async function loadScanPreview(source, container) {
  if (source.scanning) {
    container.replaceChildren(element("div", "scan-preview-note",
      "正在扫描本地目录；扫描只建立索引，不会开始上传。"));
    return;
  }
  const cached = reviewCache.get(source.id);
  if (cached) {
    renderScanPreview(source, container, cached.jobs, cached.total);
    return;
  }
  if (container.dataset.loading === "1") return;
  container.dataset.loading = "1";
  container.replaceChildren(element("div", "empty", "读取待确认文件清单…"));
  try {
    const result = await get("/api/jobs?source_id=" + encodeURIComponent(source.id) +
      "&status=pending_review&limit=500");
    reviewCache.set(source.id, {jobs: result.jobs, total: result.total});
    renderScanPreview(source, container, result.jobs, result.total);
  } catch (error) {
    container.replaceChildren(element("div", "empty", error.message));
  } finally {
    container.dataset.loading = "0";
  }
}

async function requestSourceScan(sourceId) {
  if (scanRequestSources.has(sourceId)) return;
  scanRequestSources.add(sourceId);
  expandedReviewSources.add(sourceId);
  reviewCache.delete(sourceId);
  try {
    await post("/api/source/scan", {id: sourceId});
    notice("已开始增量扫描。扫描只检查新增和变化文件，不会自动上传。", true);
    await refresh();
  } catch (error) {
    notice(error.message);
  } finally {
    scanRequestSources.delete(sourceId);
  }
}

function renderCounts(counts) {
  const sum = key => counts[key]?.count || 0;
  const total = Object.values(counts).reduce((n, v) => n + v.count, 0);
  $("stat-total").textContent = total;
  $("stat-queued").textContent = sum("queued") + sum("paused");
  $("stat-accepted").textContent = sum("api_accepted");
  $("stat-failed").textContent = sum("failed") + sum("retrying") + sum("interrupted");
  const processed = sum("api_accepted") + sum("duplicate");
  const pct = total ? Math.round(processed * 100 / total) : 0;
  $("task-percent").textContent = pct + "%";
  $("task-bar").style.width = pct + "%";
}

// These files have been accepted by the upload API, NOT independently
// verified on the Google Photos website. Keep their source active so a future
// scan can discover and upload newly added files.
function isApiProcessedSource(source) {
  const total = Number(source.indexed_files) || 0;
  return source.ui_visibility === "visible" && !source.archived && total > 0 &&
    (Number(source.api_accepted) || 0) === total && !source.uploading;
}

function renderSources(sources) {
  const target = $("sources-list");
  clear(target);
  const processedCount = sources.filter(isApiProcessedSource).length;
  const processedToggle = $("show-completed-btn");
  processedToggle.hidden = processedCount === 0;
  processedToggle.textContent = (showCompletedSources ? "收起已处理" : "查看已处理") +
    "（" + processedCount + "）";
  processedToggle.setAttribute("aria-pressed", showCompletedSources ? "true" : "false");
  const visibleSources = showCompletedSources ? sources : sources.filter(s => !isApiProcessedSource(s));
  if (!visibleSources.length) {
    target.appendChild(element("div", "empty", processedCount
      ? "当前没有需要处理的来源。" + processedCount + " 个来源的现有文件已被 API 接收，点击“查看已处理”可查看。"
      : "还没有添加文件夹。添加后先扫描并确认相册，只有明确允许的来源才会上传。"));
    return;
  }
  for (const source of visibleSources) {
    const row = element("div", "source-entry" + (source.archived ? " archived" : ""));
    row.appendChild(element("span", "source-ic", source.kind === "directory" ? "▣" : "▤"));
    const info = element("div", "source-meta");
    const sourceName = element("strong", null, source.path.split("/").pop() || source.path);
    sourceName.title = source.path;
    info.appendChild(sourceName);
    const badges = [source.location_kind === "network" ? "远程共享" : "本地 / 映射盘"];
    if (source.ui_visibility === "removed") badges.push("已从界面移除 · 历史保留");
    else if (source.ui_visibility === "hidden") badges.push("已隐藏");
    else if (source.archived) badges.push("已归档");
    else if (source.availability === "offline") badges.push("离线 · 历史保留");
    else if (source.availability === "interrupted") badges.push("扫描中断");
    else if (source.availability === "unknown") badges.push("等待重新扫描");
    else if (!source.enabled) badges.push("已暂停");
    if (isApiProcessedSource(source)) badges.push("现有文件已处理 · 新文件仍会继续检查");
    else if (!source.album_confirmed && !source.archived) badges.push("请先确认相册，才能允许上传");
    else if (source.enabled && !source.archived)
      badges.push(source.upload_ready
        ? (currentStatus?.upload_enabled ? "参与自动同步 · 全局运行中" : "已允许上传 · 全局暂停")
        : "未加入自动同步 · 仅建立索引");
    if (source.api_accepted > 0 && !source.album_key)
      badges.push("相册 ID 未绑定 · 暂停后续上传");
    else if (source.album_key)
      badges.push("已绑定云端相册");
    const sourcePath = element("small", null, source.path);
    sourcePath.title = source.path; // truncated long paths remain inspectable.
    info.appendChild(sourcePath);
    info.appendChild(element("small", "source-badges", badges.join(" · ")));
    const uploaded = source.api_accepted || 0;
    const all = source.indexed_files || 0;
    info.appendChild(element("small", "source-badges", all
      ? "已发现 " + all + " 项（照片 " + source.images + " / 视频 " + source.videos +
        "） · API 已接收 " + uploaded + "/" + all +
        " · 待处理 " + Math.max(0, all - uploaded) +
        (source.cloud_verified ? " · 已人工核验 " + source.cloud_verified : "")
      : "尚未发现媒体（可能正在扫描，也可能是空目录）"));
    info.appendChild(element("small", "source-badges",
      "画质：" + (source.upload_quality === "original" ? "Original quality（原画质）" :
        "Storage saver（节省空间）")));
    info.appendChild(element("small", "source-album-caption",
      "Google Photos 相册：" + (source.album_name || "尚未设定") +
      (source.album_confirmed ? "" : " · 待手动确认")));
    row.appendChild(info);
    // Keep every action inside ONE grid cell. Previously they were siblings of
    // the text column and a full-width <details>; flexbox compressed the path
    // into a ~10px column, rendering Chinese and Latin text vertically.
    const controls = element("div", "source-controls");
    const index = element("button", "btn soft", "查看索引");
    index.addEventListener("click", () => {
      $("job-source-filter").value = String(source.id);
      selectedSourceId = String(source.id);
      pageOffset = 0;
      $("index-details").open = true;
      showFolders(source);
      refresh();
      $("index").scrollIntoView({behavior: "smooth", block: "start"});
    });
    controls.appendChild(index);
    if (source.ui_visibility === "visible" && !source.archived) {
      const scan = element("button", "btn soft",
        source.scanning || scanRequestSources.has(source.id) ? "扫描中…" : "增量扫描");
      scan.type = "button";
      scan.disabled = !!source.scanning || scanRequestSources.has(source.id) ||
        source.availability === "offline";
      scan.title = source.availability === "offline"
        ? "请先重新挂载本地磁盘或网络共享"
        : "手动检查这个来源的新增和变化文件；扫描不会上传";
      scan.addEventListener("click", () => requestSourceScan(source.id));
      controls.appendChild(scan);
    }
    if (source.ui_visibility === "removed") {
      const restore = element("button", "btn primary", "重新启用");
      restore.title = "已挂载时单击恢复，接着上传未完成文件；不重传已接收的内容";
      restore.addEventListener("click", () => {
        expandedReviewSources.add(source.id);
        reviewCache.delete(source.id);
        action("/api/source/restore", {id: source.id},
          "映射已恢复并扫描一次；保留原进度，新文件等待你确认后才上传");
      });
      controls.appendChild(restore);
    } else if (source.ui_visibility === "hidden") {
      const show = element("button", "btn soft", "显示");
      show.addEventListener("click", () =>
        action("/api/source/display", {id: source.id, mode: "visible"},
          "已恢复显示，备份与同步设置保持不变"));
      controls.appendChild(show);
    } else if (source.archived) {
      const restore = element("button", "btn primary", "恢复历史");
      restore.addEventListener("click", () => {
        expandedReviewSources.add(source.id);
        reviewCache.delete(source.id);
        action("/api/source/restore", {id: source.id},
          "历史来源已恢复并扫描一次；旧文件记录保留，新文件等待确认。");
      });
      controls.appendChild(restore);
    } else {
      if (!source.enabled) {
        const resume = element("button", "btn soft", "恢复此来源");
        resume.title = "恢复目录扫描，但不会擅自开启上传许可";
        resume.addEventListener("click", () => action("/api/source/toggle",
          {id: source.id, enabled: true}, "来源扫描已恢复。需要上传时再开启来源同步。"));
        controls.appendChild(resume);
      } else if (!source.album_confirmed) {
        const setup = element("button", "btn primary", "先确认相册");
        setup.title = "当前来源相册未确认，所以不能开启同步；点击展开相册设置";
        setup.addEventListener("click", () => {
          album.open = true;
          expandedAlbumSources.add(source.id);
          album.scrollIntoView({behavior: "smooth", block: "center"});
        });
        controls.appendChild(setup);
      } else {
        // Only ONE per-source sync control. The old unlabeled green switch
        // controlled scanning, not upload, which was confusing next to the
        // separate "允许上传" button. Keep that scanning API for compatibility.
        const syncControl = element("label", "source-sync-control");
        syncControl.appendChild(element("span", "source-sync-label", "此来源同步"));
        const syncSwitch = element("span", "switch");
        const permission = element("input");
        permission.type = "checkbox";
        permission.checked = !!source.upload_ready;
        permission.title = source.upload_ready ? "关闭此来源的后续上传" : "允许此来源参与全局同步";
        permission.addEventListener("change", async () => {
          const enabled = permission.checked;
          if (enabled && !confirm("允许此来源参与自动同步？\n相册：" + source.album_name +
            "\n画质：" + (source.upload_quality === "original" ? "Original quality" : "Storage saver") +
            "\n只有顶部总开关开启时才会上传未完成文件。")) {
            permission.checked = false;
            return;
          }
          await action("/api/source/upload", {id: source.id, enabled},
            enabled ? (currentStatus?.auto_sync_enabled ? "此来源已加入同步。" : "来源许可已保存；顶部同步当前暂停。") :
              "此来源已暂停后续上传，原文件与历史保留。");
        });
        syncSwitch.append(permission, element("span"));
        syncControl.append(syncSwitch, element("span", "source-sync-state",
          source.upload_ready ? "已允许" : "已暂停"));
        controls.appendChild(syncControl);
      }
    }
    if (source.ui_visibility === "visible") {
      const more = element("details", "source-more-actions");
      more.appendChild(element("summary", null, "更多"));
      const morePanel = element("div", "source-more-panel");
      const hide = element("button", "btn soft", "隐藏");
      hide.title = "只整理界面，不暂停同步、不更改媒体历史";
      hide.addEventListener("click", () => {
        collapseHiddenSourceDetails(source.id);
        action("/api/source/display", {id: source.id, mode: "hidden"},
          "索引已隐藏，数据库和备份历史完整保留");
      });
      morePanel.appendChild(hide);
      const remove = element("button", "btn warn", "删除显示");
      remove.title = "停止此来源并移除映射；保留照片、SQLite 和已上传历史";
      remove.addEventListener("click", () => {
        if (confirm("停止此来源并移除映射？不删除任何照片、数据库或上传进度。")) {
          collapseHiddenSourceDetails(source.id);
          action("/api/source/display", {id: source.id, mode: "removed"},
            "已停止该来源并保存全部进度，重新添加相同目录即可继续");
        }
      });
      morePanel.appendChild(remove);
      more.appendChild(morePanel);
      controls.appendChild(more);
    }
    row.appendChild(controls);
    const events = element("details", "source-event-details");
    const eventHeader = element("summary", null, "操作记录");
    events.appendChild(eventHeader);
    events.addEventListener("toggle", async () => {
      if (events.open) expandedEventSources.add(source.id);
      else expandedEventSources.delete(source.id);
      if (!events.open || events.dataset.loaded) return;
      try {
        const data = await get("/api/source/events?source_id=" + source.id);
        for (const entry of data.events) {
          events.appendChild(element("div", "event-line",
            entry.created_at + " · " + entry.action + " · " + entry.note));
        }
        if (!data.events.length) events.appendChild(element("div", "event-line", "尚无操作历史"));
        events.dataset.loaded = "1";
      } catch (error) { events.appendChild(element("div", "event-line", error.message)); }
    });
    if (expandedEventSources.has(source.id)) events.open = true;
    row.appendChild(events);

    const album = element("details", "source-album-settings");
    const summary = element("summary", null, "上传前设置：相册名称、画质和单张试传");
    album.appendChild(summary);
    const albumBody = element("div", "source-album-form");
    const input = element("input", "album-name-input");
    input.type = "text";
    input.maxLength = 120;
    input.autocomplete = "off";
    input.placeholder = "Google Photos 相册名称";
    input.value = albumDrafts.get(source.id) ?? source.album_name ?? "";
    input.addEventListener("input", () => albumDrafts.set(source.id, input.value));
    input.title = "默认使用来源文件夹名称，可改为旅行名称，再点击保存并确认";
    albumBody.appendChild(input);
    const confirmAlbum = element("button", "btn primary", "保存并确认相册");
    confirmAlbum.type = "button";
    confirmAlbum.addEventListener("click", async () => {
      try {
        const result = await post("/api/source/album",
          {id: source.id, album_name: input.value});
        albumDrafts.delete(source.id);
        notice("已保存相册名：" + input.value + "。已上传文件不重新传。", true);
        await refresh();
      } catch (error) { notice(error.message); }
    });
    albumBody.appendChild(confirmAlbum);
    const bindingStatus = element("small", "source-album-hint",
      source.album_key ? "已绑定云端相册 ID；后续照片会加入同一个相册。" :
      (source.api_accepted > 0 ?
        "重要：历史文件已上传但缺少相册 ID。为防止重复创建，已阻止此来源继续上传，请绑定一个已存在的相册。" :
        "首次成功上传会创建相册并自动保存 ID，后续复用同一个相册。"));
    albumBody.appendChild(bindingStatus);
    if (source.album_key) {
      const link = element("a", "source-album-link", "在 Google Photos 查看已绑定相册");
      link.href = "https://photos.google.com/album/" + source.album_key;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      albumBody.appendChild(link);
    } else {
      const bindInput = element("input", "album-name-input");
      bindInput.type = "url";
      bindInput.placeholder = "粘贴已有 Google Photos 相册链接";
      bindInput.autocomplete = "off";
      albumBody.appendChild(bindInput);
      const bindButton = element("button", "btn soft", "绑定现有相册（防止重复创建）");
      bindButton.type = "button";
      bindButton.disabled = !!currentStatus?.upload_enabled;
      bindButton.addEventListener("click", async () => {
        if (!confirm("确认此相册属于当前来源目录？后续文件会加入此相册，不会自动整理已创建的其他相册。")) return;
        try {
          await post("/api/source/album/bind", {id: source.id, album_ref: bindInput.value});
          notice("已保存云端相册 ID。不会删除或重传旧文件。", true);
          await refresh();
        } catch (error) { notice(error.message); }
      });
      albumBody.appendChild(bindButton);
    }
    const qualityLabel = element("label", "source-quality-label", "后续上传画质");
    const qualitySelect = element("select", "source-quality-select");
    for (const choice of [
      {value: "original", text: "Original quality（默认，原始画质）"},
      {value: "storage_saver", text: "Storage saver（节省空间）"}
    ]) {
      const option = document.createElement("option");
      option.value = choice.value;
      option.textContent = choice.text;
      qualitySelect.appendChild(option);
    }
    qualitySelect.value = source.upload_quality || "original";
    qualitySelect.disabled = !!source.uploading ||
      (!!source.upload_ready && !!currentStatus?.upload_enabled);
    qualitySelect.title = "来源正在实际上传时请先点击“暂停此来源上传”";
    qualitySelect.addEventListener("change", async () => {
      const next = qualitySelect.value;
      if (next === "original" && !confirm(
        "原画质可能占用 Google 账号空间。只影响未上传的文件，建议先单张试传核对配额。确认切换吗？")) {
        qualitySelect.value = source.upload_quality || "original";
        return;
      }
      qualitySelect.disabled = true;
      try {
        await post("/api/source/quality", {id: source.id, quality: next});
        notice("画质已设置为 " + (next === "original" ? "Original quality" : "Storage saver") +
          "，只影响未上传的文件。", true);
        await refresh();
      } catch (error) {
        qualitySelect.value = source.upload_quality || "original";
        qualitySelect.disabled = false;
        notice(error.message);
      }
    });
    albumBody.appendChild(qualityLabel);
    albumBody.appendChild(qualitySelect);
    const test = element("button", "btn soft", "仅试传 1 张照片");
    test.type = "button";
    test.disabled = !source.album_confirmed || !currentStatus?.allow_real_upload
      || !currentStatus?.credentials_present || currentStatus?.upload_enabled;
    test.title = !source.album_confirmed ? "请先确认相册名称" :
      !currentStatus?.credentials_present ? "请先在 Mac 本机完成独立账号授权" :
      !currentStatus?.allow_real_upload ? "需以 --allow-real-upload 重启 WebUI" :
      currentStatus?.upload_enabled ? "请先关闭批量上传开关" : "先找当前来源，已传完则从其他已确认来源选一张，绝不启动批量";
    test.addEventListener("click", async () => {
      test.disabled = true;
      try {
        const preview = await get("/api/source/test-candidate?source_id=" + encodeURIComponent(source.id));
        const pick = preview.candidate;
        const quality = pick.quality === "original" ? "Original quality（可能占用配额）" : "Storage saver";
        const sourceNote = pick.fallback ?
          "当前来源没有未上传照片，已从其他来源找到一张。\n" : "";
        if (!confirm(sourceNote + "测试文件：" + pick.name + "\n目标相册：「" + pick.album +
            "」\n试传画质：" + quality + "\n只传这一张，不开启批量上传。继续吗？")) {
          test.disabled = false;
          return;
        }
        const result = await post("/api/source/test-upload",
                                  {id: source.id, candidate_id: pick.id});
        const job = result.test;
        notice("单张测试结果：" + job.name + " · " + job.status +
          " · 相册「" + job.album + "」 · " + (job.quality === "original" ? "原始画质" : "节省空间") +
          (job.error ? " · " + job.error : " · 请进入 Google Photos 官方页面核对相册和配额"), true);
        await refresh();
      } catch (error) { notice(error.message); test.disabled = false; }
    });
    albumBody.appendChild(test);
    albumBody.appendChild(element("small", "source-album-hint",
      "新来源默认不会上传。先确认相册与画质；全局暂停时可单张测试，确认后打开“此来源同步”即可。"));
    album.appendChild(albumBody);
    album.addEventListener("toggle", () => {
      if (album.open) expandedAlbumSources.add(source.id);
      else expandedAlbumSources.delete(source.id);
    });
    if (expandedAlbumSources.has(source.id)) album.open = true;
    row.appendChild(album);

    if (source.ui_visibility === "visible" && !source.archived &&
        (source.pending_review_count > 0 || source.scanning || expandedReviewSources.has(source.id))) {
      const review = element("details", "source-review-details");
      const reviewTitle = source.scanning ? "正在扫描…" :
        "待确认 " + (source.pending_review_count || 0) + " 项 · " +
        humanSize(source.pending_review_bytes || 0);
      review.appendChild(element("summary", null, reviewTitle));
      const reviewBody = element("div", "source-review-body");
      review.appendChild(reviewBody);
      review.addEventListener("toggle", () => {
        if (review.open) {
          expandedReviewSources.add(source.id);
          loadScanPreview(source, reviewBody);
        } else {
          expandedReviewSources.delete(source.id);
        }
      });
      if (expandedReviewSources.has(source.id)) {
        review.open = true;
        loadScanPreview(source, reviewBody);
      }
      row.appendChild(review);
    }
    target.appendChild(row);
  }
}

// Folder totals include all descendants. "Remaining" means not yet API-accepted,
// not "verified in Google Photos", and may include queued/failed/duplicate items.
function folderUploadProgress(acceptedCount, fileCount) {
  const total = Number.isFinite(Number(fileCount)) ? Math.max(0, Math.floor(Number(fileCount))) : 0;
  const accepted = Number.isFinite(Number(acceptedCount)) ?
    Math.min(total, Math.max(0, Math.floor(Number(acceptedCount)))) : 0;
  const remaining = total - accepted;
  const percent = count => total ? Math.round(count * 1000 / total) / 10 : 0;
  return {total, accepted, remaining, acceptedPercent: percent(accepted),
          remainingPercent: percent(remaining)};
}

async function showFolders(source) {
  const target = $("folders-list");
  const summary = $("index-summary");
  const overall = folderUploadProgress(source.api_accepted, source.indexed_files);
  const sourceName = source.path.replace(/\/$/, "").split("/").pop() || source.path;
  summary.title = source.path;
  summary.textContent = sourceName + " · " + source.indexed_folders + " 个目录 · " +
    "API 已接收 " + overall.accepted + "/" + overall.total + "（" + overall.acceptedPercent +
    "%）· 未接收 " + overall.remaining + "（" + overall.remainingPercent +
    "%）· 人工核验 " + source.cloud_verified;
  if (!$("index-details").open) return;
  target.replaceChildren(element("div", "empty", "读取 SQLite 目录索引中…"));
  try {
    const result = await get("/api/folders?source_id=" + encodeURIComponent(source.id)
      + (showHiddenRecords ? "&include_hidden=1" : ""));
    clear(target);
    if (!result.folders.length) {
      target.appendChild(element("div", "empty", "此来源尚未建立目录索引。重新连接硬盘后执行扫描即可。"));
      return;
    }
    const table = element("table", "folder-table");
    const head = element("thead");
    const tr = element("tr");
    for (const col of ["目录", "媒体构成", "上传进度（API 已接收）", "尚未接收", "云端人工核验"]) {
      tr.appendChild(element("th", null, col));
    }
    head.appendChild(tr);
    table.appendChild(head);
    const body = element("tbody");
    const basePath = source.kind === "file" ?
      source.path.slice(0, source.path.lastIndexOf("/")) : source.path.replace(/\/$/, "");
    for (const folder of result.folders) {
      const row = element("tr");
      const progress = folderUploadProgress(folder.accepted_count, folder.file_count);
      const displayPath = folder.path === basePath ? "根目录（含子目录）" :
        folder.path.startsWith(basePath + "/") ?
        folder.path.slice(basePath.length + 1) : folder.path;
      const pathCell = element("td", "folder-path-cell");
      const pathText = element("span", "folder-relative-path", displayPath);
      pathText.title = folder.path;
      pathCell.appendChild(pathText);
      row.appendChild(pathCell);

      const mediaCell = element("td", "folder-media-cell");
      mediaCell.appendChild(element("strong", null, progress.total + " 项"));
      mediaCell.appendChild(element("small", null,
        "照片 " + folder.image_count + " · 视频 " + folder.video_count));
      row.appendChild(mediaCell);

      const uploadedCell = element("td", "folder-upload-cell");
      const topLine = element("div", "folder-upload-label");
      topLine.appendChild(element("strong", null, progress.accepted + " / " + progress.total));
      topLine.appendChild(element("span", "folder-upload-percent", progress.acceptedPercent + "%"));
      uploadedCell.appendChild(topLine);
      const track = element("div", "folder-progress-track");
      track.setAttribute("role", "progressbar");
      track.setAttribute("aria-label", displayPath + " API 已接收比例");
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", "100");
      track.setAttribute("aria-valuenow", String(progress.acceptedPercent));
      const fill = element("div", "folder-progress-fill");
      fill.style.width = progress.acceptedPercent + "%";
      track.appendChild(fill);
      uploadedCell.appendChild(track);
      row.appendChild(uploadedCell);

      const remainingCell = element("td", "folder-remaining-cell");
      remainingCell.appendChild(element("strong", null, progress.remaining + " 项"));
      remainingCell.appendChild(element("small", null, progress.remainingPercent + "% 未接收"));
      row.appendChild(remainingCell);

      const verifiedCell = element("td", "folder-verified-cell");
      verifiedCell.appendChild(element("strong", null, folder.verified_count));
      if (folder.missing_count) verifiedCell.appendChild(element("small", "folder-missing",
        "离线 / 丢失 " + folder.missing_count));
      row.appendChild(verifiedCell);
      body.appendChild(row);
    }
    table.appendChild(body);
    target.appendChild(table);
  } catch (error) {
    target.replaceChildren(element("div", "empty", error.message));
  }
}

function renderJobFilters(sources) {
  const select = $("job-source-filter");
  const previous = select.value;
  clear(select);
  const first = element("option", null, "全部来源（包括历史）");
  first.value = "";
  select.appendChild(first);
  for (const source of sources) {
    const option = element("option", null,
      (source.archived ? "[归档] " : "") + source.path.split("/").pop() + " · " + source.id);
    option.value = String(source.id);
    select.appendChild(option);
  }
  select.value = sources.some(s => String(s.id) === previous) ? previous : "";
}

function renderJobTransfer(job, current) {
  const labels = {
    queued: "尚未传输", uploading: "上传中 · 字节比例未知",
    api_accepted: "API 接收 · 未自动云端核验",
    duplicate: "内容相同 · 跳过", retrying: "等待下一次重试",
    failed: "失败，未完成", interrupted: "结果未知 · 需先核对云端", paused: "已暂停"
  };
  const cell = element("td", "muted job-transfer-cell", labels[job.status] || "—");
  if (job.status !== "uploading" || current?.job_id !== job.id) return cell;

  const confirmation = "等待 Google Photos 确认";
  const phases = {
    starting: "准备上传", hashing: "正在校验文件", checking: "正在检查云端文件",
    finalizing: confirmation, completed: confirmation
  };
  if (current.status !== "uploading") {
    cell.textContent = phases[current.status] || cell.textContent;
    return cell;
  }

  const {bytes_uploaded: uploaded, bytes_total: total, attempt} = current;
  if (!Number.isSafeInteger(total) || total <= 0 ||
      !Number.isSafeInteger(uploaded) || uploaded < 0 || uploaded > total) return cell;

  const retry = Number.isInteger(attempt) && attempt > 1 ? "第 " + attempt + " 次尝试" : "";
  if (uploaded === 0) {
    cell.textContent = retry ? "等待传输数据 · " + retry : "等待传输数据";
    return cell;
  }

  const percent = Math.floor(uploaded / total * 1000) / 10;
  const label = humanSize(uploaded) + " / " + humanSize(total) + " · " + percent + "%";
  const bar = element("progress", "job-transfer-bar");
  bar.max = total;
  bar.value = uploaded;
  bar.setAttribute("aria-label", "本次文件传输进度");
  bar.setAttribute("aria-valuetext", label);
  cell.replaceChildren(element("span", "job-transfer-count", label), bar);
  const detail = [uploaded === total ? confirmation : "", retry].filter(Boolean).join(" · ");
  if (detail) cell.appendChild(element("span", "job-transfer-detail", detail));
  return cell;
}

function renderJobs(jobs, current) {
  const body = $("jobs-body");
  clear(body);
  if (!jobs.length) {
    const tr = element("tr");
    const td = element("td", "empty", "暂无符合条件的历史任务。文件夹或网络盘重新挂载后可扫描。");
    td.colSpan = 7;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  for (const job of jobs) {
    const tr = element("tr");
    const nameCell = element("td");
    nameCell.appendChild(element("div", "filename", job.name));
    nameCell.appendChild(element("div", "path", job.path));
    if (!job.file_available) nameCell.appendChild(element("div", "path", "当前文件不可访问 · 历史保留"));
    tr.appendChild(nameCell);
    tr.appendChild(element("td", null,
      (job.media_kind === "video" ? "视频" : job.media_kind === "image" ? "图片" : "媒体")
      + " · " + (job.extension || "未知").toUpperCase()));
    tr.appendChild(element("td", null, humanSize(job.bytes)));
    const statusCell = element("td");
    statusCell.appendChild(element("span", "status " + job.status,
      statusText[job.status] || job.status));
    if (job.error) {
      const hint = element("div", "path", job.error);
      hint.title = job.error;
      statusCell.appendChild(hint);
    }
    tr.appendChild(statusCell);
    const verifiedCell = element("td");
    if (job.cloud_verified_at) {
      verifiedCell.appendChild(element("span", "status api_accepted", "人工已核验"));
      verifiedCell.appendChild(element("div", "path", job.cloud_verified_at));
    } else {
      verifiedCell.appendChild(element("span", "muted", "未核验"));
    }
    tr.appendChild(verifiedCell);
    tr.appendChild(renderJobTransfer(job, current));
    const actions = element("td");
    if (["failed", "retrying", "interrupted"].includes(job.status)) {
      const retry = element("button", "btn soft", "重新入队");
      retry.addEventListener("click", () => {
        if (job.status !== "interrupted" || confirm("这项任务在上传中断时云端结果未知，请先检查 Google Photos 是否已经存在，再决定是否重试。确定重新入队？")) {
          action("/api/retry", {id: job.id}, "已重新入队");
        }
      });
      actions.appendChild(retry);
    } else if (job.status === "api_accepted") {
      const verify = element("button", "btn soft", job.cloud_verified_at ? "取消核验" : "人工确认");
      verify.addEventListener("click", () => {
        const next = !job.cloud_verified_at;
        if (!next || confirm("请先在 Google Photos 官方页面核对这项媒体确实存在。此操作只记录人工核验，不代表 Google 官方 API 自动验证。是否已核实？")) {
          action("/api/cloud/verify", {id: job.id, verified: next},
            next ? "已记录人工核验时间" : "已取消人工核验标记");
        }
      });
      actions.appendChild(verify);
    } else {
      actions.appendChild(element("span", "muted", "—"));
    }
    tr.appendChild(actions);
    body.appendChild(tr);
  }
}

function renderPagination(result) {
  const total = result.total || 0;
  const first = total ? result.offset + 1 : 0;
  const last = Math.min(total, result.offset + result.jobs.length);
  $("page-label").textContent = first + "–" + last + " / " + total + " 条";
  $("page-prev").disabled = result.offset <= 0;
  $("page-next").disabled = last >= total;
}

async function refresh() {
  try {
    const status = await get("/api/status" + (showHiddenRecords ? "?include_hidden=1" : ""));
    csrf = status.csrf;
    currentStatus = status;
    renderCounts(status.counts);
    if (status.upload_progress) renderUploadProgress(status.upload_progress);
    renderSources(status.sources);
    renderJobFilters(status.sources);
    $("show-hidden-btn").textContent = (showHiddenRecords ? "隐藏历史记录" : "显示隐藏记录")
      + "（" + status.hidden_sources + "）";
    $("show-hidden-btn").setAttribute("aria-pressed", showHiddenRecords ? "true" : "false");
    $("stored-history-label").textContent = " SQLite 全库仍保存 " + status.stored_files + " 项媒体历史。";
    if ($("jobs-details").open) {
      const params = new URLSearchParams();
      if ($("job-source-filter").value) params.set("source_id", $("job-source-filter").value);
      if ($("job-kind-filter").value) params.set("kind", $("job-kind-filter").value);
      if ($("job-status-filter").value) params.set("status", $("job-status-filter").value);
      if (showHiddenRecords) params.set("include_hidden", "1");
      params.set("limit", String(pageSize));
      params.set("offset", String(pageOffset));
      const tasks = await get("/api/jobs?" + params.toString());
      renderJobs(tasks.jobs, status.upload_progress?.current);
      renderPagination(tasks);
    }
    $("sync-switch").checked = !!status.auto_sync_enabled;
    $("stop-all-btn").disabled = !status.auto_sync_enabled;
    $("credential-state").textContent = status.credentials_present
      ? "存在本机凭据（有效性未验证）" : "尚未配置独立账号";
    $("engine-state").textContent = status.upload_engine === "owned"
      ? (status.owned_build_verified ? "自行编译 · SHA 校验通过" : "自行编译 · 尚未通过构建验证")
      : "第三方发行版 · 固定 SHA-256";
    $("upload-reason").textContent = status.auto_sync_enabled
      ? "正在运行：只处理下方“此来源同步”已允许的目录。新添加的目录仍需确认相册。"
      : (status.allow_real_upload && status.credentials_present
        ? "已暂停：不会开始新文件；已接收和待上传记录全部保留。"
        : "尚未完成本机账号授权或上传引擎未就绪。");
    $("scan-label").textContent = status.scan_running ? "正在扫描" : "手动扫描模式";
    $("last-scan").textContent = status.last_scan
      ? "最近扫描：" + status.last_scan + (status.last_scan_error ? " · " + status.last_scan_error : "")
      : "尚未扫描";
  } catch (error) {
    notice("本地 WebUI 服务暂不可达：" + error.message);
  }
}

async function browse(path) {
  try {
    const data = await get("/api/browse" + (path ? "?path=" + encodeURIComponent(path) : ""));
    browserDirectory = data.path;
    selectedFile = "";
    $("browser-path").value = data.path;
    const target = $("browser-items");
    clear(target);
    for (const folder of data.folders) {
      const row = element("div", "browser-row");
      row.appendChild(element("span", null, "▣  " + folder.name));
      row.appendChild(element("small", null, "打开 ›"));
      row.addEventListener("click", () => browse(folder.path));
      target.appendChild(row);
    }
    for (const file of data.files) {
      const row = element("div", "browser-row");
      row.appendChild(element("span", null, "▤  " + file.name));
      row.appendChild(element("small", null, humanSize(file.bytes)));
      row.addEventListener("click", () => {
        if (modalKind === "directory") {
          notice("请选择文件夹，或将类型切换为“单个文件”");
          return;
        }
        selectedFile = file.path;
        $("browser-path").value = file.path;
        target.querySelectorAll(".selected").forEach(node => node.classList.remove("selected"));
        row.classList.add("selected");
      });
      target.appendChild(row);
    }
    if (!target.children.length) target.appendChild(element("div", "empty", "没有可用的子文件夹或媒体文件"));
    $("up-btn").disabled = !data.parent;
    $("up-btn").onclick = () => browse(data.parent);
  } catch (error) {
    $("browser-items").replaceChildren(element("div", "empty", error.message));
  }
}

async function refreshVolumes() {
  const root = $("network-mounts");
  root.replaceChildren(element("div", "empty", "读取 macOS 已挂载网络共享…"));
  try {
    const volumes = await get("/api/volumes");
    clear(root);
    if (!volumes.network.length) {
      root.appendChild(element("div", "empty",
        "当前没有已挂载 SMB/NFS/WebDAV 网络共享。先输入 smb:// 地址，在 Finder 授权后刷新。"));
    }
    for (const volume of volumes.network) {
      const button = element("button", "browser-row network-choice");
      button.type = "button";
      button.appendChild(element("span", null, "▣ " + volume.name + " · " + volume.fs_type.toUpperCase()));
      button.appendChild(element("small", null, "选择网络盘 ›"));
      button.addEventListener("click", () => browse(volume.path));
      root.appendChild(button);
    }
  } catch (error) {
    root.replaceChildren(element("div", "empty", error.message));
  }
}

async function connectShare() {
  const url = $("share-url").value.trim();
  if (!url.startsWith("smb://")) {
    notice("请输入 smb://服务器/共享文件夹；不要在地址中附加账号或密码");
    return;
  }
  try {
    const result = await post("/api/share/connect", {url});
    notice(result.message, true);
    await refreshVolumes();
  } catch (error) {
    notice(error.message);
  }
}

function selectStorage(mode) {
  const network = mode === "network";
  $("storage-local").classList.toggle("selected", !network);
  $("storage-network").classList.toggle("selected", network);
  $("network-mount-panel").hidden = !network;
  if (network) refreshVolumes();
}

function openDialog() {
  modalKind = "directory";
  document.querySelector('input[name="kind"][value="directory"]').checked = true;
  selectStorage("local");
  $("source-dialog").showModal();
  browse();
}

async function addSource() {
  const type = document.querySelector('input[name="kind"]:checked').value;
  const path = $("browser-path").value.trim();
  try {
    const result = await post("/api/sources", {kind: type, path});
    const added = result.sources?.find(source => source.path === path) || result.sources?.[0];
    if (added) {
      expandedReviewSources.add(added.id);
      reviewCache.delete(added.id);
    }
    $("source-dialog").close();
    notice("已添加来源并开始首次扫描；扫描不会自动上传。请先检查文件、相册和画质，再确认上传。", true);
    await refresh();
  } catch (error) {
    $("browser-items").replaceChildren(element("div", "empty", error.message));
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("add-btn").addEventListener("click", openDialog);
  $("show-hidden-btn").addEventListener("click", () => {
    showHiddenRecords = !showHiddenRecords;
    pageOffset = 0;
    if (!showHiddenRecords) {
      $("index-details").open = false;
      selectedSourceId = "";
      $("index-summary").textContent = "目录明细已收起。选择来源并点击“查看索引”可展开。";
    }
    refresh();
  });
  $("show-completed-btn").addEventListener("click", () => {
    showCompletedSources = !showCompletedSources;
    refresh();
  });
  $("index-details").addEventListener("toggle", () => {
    if ($("index-details").open && currentStatus?.sources?.length) {
      const source = currentStatus.sources.find(s => String(s.id) === selectedSourceId)
        || currentStatus.sources[0];
      selectedSourceId = String(source.id);
      showFolders(source);
    }
  });
  $("jobs-details").addEventListener("toggle", () => {
    if ($("jobs-details").open) refresh();
  });
  $("close-dialog").addEventListener("click", () => $("source-dialog").close());
  $("cancel-btn").addEventListener("click", () => $("source-dialog").close());
  $("confirm-btn").addEventListener("click", addSource);
  $("browse-btn").addEventListener("click", () => browse($("browser-path").value));
  $("storage-local").addEventListener("click", () => selectStorage("local"));
  $("storage-network").addEventListener("click", () => selectStorage("network"));
  $("refresh-volumes").addEventListener("click", refreshVolumes);
  $("connect-share-btn").addEventListener("click", connectShare);
  $("scan-btn").addEventListener("click", () => {
    reviewCache.clear();
    action("/api/scan", {}, "已请求扫描所有来源；扫描只建立索引，不会自动上传。");
  });
  $("refresh-btn").addEventListener("click", refresh);
  $("page-prev").addEventListener("click", () => {
    pageOffset = Math.max(0, pageOffset - pageSize);
    refresh();
  });
  $("page-next").addEventListener("click", () => {
    pageOffset += pageSize;
    refresh();
  });
  for (const select of ["job-source-filter", "job-kind-filter", "job-status-filter"]) {
    $(select).addEventListener("change", () => { pageOffset = 0; refresh(); });
  }
  $("sync-switch").addEventListener("change", e => {
    if (e.target.checked && !confirm(
      "开启全部自动同步？只有下方“此来源同步”设为已允许的目录才会上传；新目录默认不上传。")) {
      e.target.checked = false;
      return;
    }
    action("/api/sync", {enabled: e.target.checked},
      e.target.checked ? "全局同步已开启，只处理明确允许上传的来源。" :
        "已停止全部后续上传和自动扫描，历史与队列完整保留。");
  });
  $("stop-all-btn").addEventListener("click", () =>
    action("/api/sync", {enabled: false},
      "全部上传已停止，不再领取新任务；如有在途文件，可让当前文件完成。"));
  for (const button of document.querySelectorAll('input[name="kind"]')) {
    button.addEventListener("change", e => {
      modalKind = e.target.value;
      $("browser-path").value = browserDirectory;
      selectedFile = "";
      browse(browserDirectory);
    });
  }
  refresh();
  refreshProgress();
  setInterval(refresh, 4000);
  setInterval(refreshProgress, 1000);
});
