const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const app = express();
const PORT = 3000;

// Configuration
const REPO_PATH = process.env.REPO_PATH || `C:\\Users\\Username\\source\\repos\\RepoName`;
const TARGET_AUTHOR = process.env.TARGET_AUTHOR || 'Username';
const DEFAULT_BRANCH = process.env.DEFAULT_BRANCH || 'master';

function getRequestConfig(req) {
    const repoPath = (req.query.repoPath || REPO_PATH).trim();
    const author = (req.query.author !== undefined ? req.query.author : TARGET_AUTHOR).trim();
    const defaultBranch = (req.query.defaultBranch || DEFAULT_BRANCH).trim();

    if (!repoPath || !defaultBranch || repoPath.length > 260 || author.length > 200 || defaultBranch.length > 120) {
        throw new Error('Repository path and base branch are required and must be within the supported length limits.');
    }

    return { repoPath, author, defaultBranch };
}

function runGit(args, repoPath = REPO_PATH) {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd: repoPath, maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr.trim() || error.message));
            } else {
                resolve(stdout);
            }
        });
    });
}

function cleanFilePath(rawPath) {
    return rawPath
        .replace(/\{.*?=>\s*(.*?)\}/g, '$1')
        .replace(/^.*?=>\s*/, '')
        .trim();
}

async function resolveBaseBranch(repoPath, defaultBranch) {
    for (const ref of [defaultBranch, `origin/${defaultBranch}`, 'main', 'origin/main']) {
        try {
            await runGit(['rev-parse', '--verify', ref], repoPath);
            return ref;
        } catch {
            // continue checking
        }
    }
    return defaultBranch;
}

app.get('/api/branches', async (req, res) => {
    try {
        const config = getRequestConfig(req);
        const branchOutput = await runGit(['branch', '-a', '--format=%(refname:short)'], config.repoPath);
        const branches = Array.from(new Set(
            branchOutput.split('\n')
                .map(b => b.trim())
                .filter(b => b && !b.includes('HEAD'))
        ));
        const baseBranch = await resolveBaseBranch(config.repoPath, config.defaultBranch);
        res.json({ branches, defaultBranch: baseBranch, author: config.author, repoPath: config.repoPath });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch branches.', details: err.message });
    }
});

app.get('/api/authors', async (req, res) => {
    try {
        const config = getRequestConfig(req);
        const branch = (req.query.branch || config.defaultBranch).trim();
        const ref = branch === '--all' ? '--all' : branch;
        const authorOutput = await runGit(['log', ref, '--format=%aN'], config.repoPath);
        const authors = Array.from(new Set(
            authorOutput.split('\n').map(author => author.trim()).filter(Boolean)
        )).sort((a, b) => a.localeCompare(b));
        res.json({ authors });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch authors.', details: err.message });
    }
});

app.get('/api/stats', async (req, res) => {
    try {
        const config = getRequestConfig(req);
        const targetBranch = (req.query.branch || config.defaultBranch).trim();
        const rangeMode = req.query.range || 'diff-master';
        const baseBranch = await resolveBaseBranch(config.repoPath, config.defaultBranch);

        const gitRangeArgs = [];
        if (rangeMode === 'diff-master') {
            if (targetBranch === '--all' || targetBranch === baseBranch || targetBranch.endsWith(`/${config.defaultBranch}`)) {
                gitRangeArgs.push(baseBranch);
            } else {
                gitRangeArgs.push(`${baseBranch}..${targetBranch}`);
            }
        } else if (targetBranch === '--all') {
            gitRangeArgs.push('--all');
        } else {
            gitRangeArgs.push(targetBranch);
        }

        const timeArgs = [];
        if (rangeMode === '7days') timeArgs.push('--since=7.days.ago');
        if (rangeMode === '30days') timeArgs.push('--since=30.days.ago');
        if (rangeMode === '90days') timeArgs.push('--since=90.days.ago');

        const commonLogArgs = [
            ...(config.author ? ['--author=' + config.author] : []),
            '-i',
            '--no-merges',
            ...gitRangeArgs,
            ...timeArgs
        ];

        // 1. Get raw commit history with per-commit stats & status
        // Format delimiter: COMMIT_START|%h|%cd|%s
        const rawLogOutput = await runGit([
            'log',
            ...commonLogArgs,
            '--numstat',
            '--summary',
            '-M',
            '--format=COMMIT_DELIM|%h|%ad|%s',
            '--date=format:%Y-%m-%d %u %H'
        ], config.repoPath);

        let added = 0;
        let removed = 0;
        const extensions = {};
        const fileChurn = {};
        const newFilesSet = new Set();
        const deletedFilesSet = new Set();
        const activeDays = new Set();

        const commitsList = [];
        let currentCommit = null;

        const sizeBuckets = {
            micro: 0,   // < 10 lines
            small: 0,   // 10 - 49 lines
            medium: 0,  // 50 - 249 lines
            large: 0,   // 250 - 999 lines
            huge: 0     // 1000+ lines
        };

        const daysOfWeek = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };
        const dayStats = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0 };
        const hourlyStats = Array(24).fill(0);
        let weekdayCommits = 0;
        let weekendCommits = 0;
        let workHoursCommits = 0;
        let afterHoursCommits = 0;

        const logLines = rawLogOutput.split('\n');

        function finalizeCurrentCommit() {
            if (!currentCommit) return;
            const total = currentCommit.added + currentCommit.removed;
            currentCommit.total = total;

            if (total < 10) sizeBuckets.micro++;
            else if (total < 50) sizeBuckets.small++;
            else if (total < 250) sizeBuckets.medium++;
            else if (total < 1000) sizeBuckets.large++;
            else sizeBuckets.huge++;

            commitsList.push(currentCommit);
        }

        for (let i = 0; i < logLines.length; i++) {
            const line = logLines[i].trim();
            if (!line) continue;

            if (line.startsWith('COMMIT_DELIM|')) {
                finalizeCurrentCommit();
                const [, hash, dateRaw, ...msgParts] = line.split('|');
                const message = msgParts.join('|');
                const [dateYMD, dayNum, hourStr] = (dateRaw || '').split(/\s+/);

                if (dateYMD) activeDays.add(dateYMD);

                if (dayNum) {
                    const dayName = daysOfWeek[dayNum];
                    if (dayName) dayStats[dayName]++;
                    if (dayNum === '6' || dayNum === '7') weekendCommits++;
                    else weekdayCommits++;
                }

                const hour = parseInt(hourStr, 10);
                if (!isNaN(hour) && hour >= 0 && hour < 24) {
                    hourlyStats[hour]++;
                    if (hour >= 9 && hour < 18) workHoursCommits++;
                    else afterHoursCommits++;
                }

                currentCommit = {
                    hash,
                    date: dateYMD || '',
                    message,
                    added: 0,
                    removed: 0,
                    total: 0,
                    filesCount: 0
                };
                continue;
            }

            // Detect new file creations or deletions from git --summary
            if (line.startsWith('create mode ')) {
                const newFilePath = cleanFilePath(line.replace(/create mode \d+\s+/, ''));
                newFilesSet.add(newFilePath);
                continue;
            }
            if (line.startsWith('delete mode ')) {
                const delFilePath = cleanFilePath(line.replace(/delete mode \d+\s+/, ''));
                deletedFilesSet.add(delFilePath);
                continue;
            }

            // Numstat parsing
            const match = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
            if (match) {
                const add = match[1] === '-' ? 0 : parseInt(match[1], 10);
                const del = match[2] === '-' ? 0 : parseInt(match[2], 10);
                const file = cleanFilePath(match[3]);
                const ext = path.extname(file).toLowerCase() || '[no ext]';

                added += add;
                removed += del;

                if (currentCommit) {
                    currentCommit.added += add;
                    currentCommit.removed += del;
                    currentCommit.filesCount += 1;
                }

                if (!extensions[ext]) extensions[ext] = { added: 0, removed: 0, touches: 0 };
                extensions[ext].added += add;
                extensions[ext].removed += del;
                extensions[ext].touches += 1;

                if (!fileChurn[file]) fileChurn[file] = { added: 0, removed: 0, total: 0, touches: 0 };
                fileChurn[file].added += add;
                fileChurn[file].removed += del;
                fileChurn[file].total += (add + del);
                fileChurn[file].touches += 1;
            }
        }
        finalizeCurrentCommit();

        // 2. All Files with status flags
        const allFiles = Object.entries(fileChurn)
            .map(([file, val]) => {
                let status = 'MODIFIED';
                if (newFilesSet.has(file)) status = 'CREATED';
                else if (deletedFilesSet.has(file)) status = 'DELETED';
                return { file, status, ...val };
            })
            .sort((a, b) => b.total - a.total);

        const newFiles = allFiles.filter(f => f.status === 'CREATED');
        const deletedFiles = allFiles.filter(f => f.status === 'DELETED');

        // 3. Biggest Commits Leaderboard
        const biggestCommits = [...commitsList]
            .sort((a, b) => b.total - a.total)
            .slice(0, 15);

        // 4. Extension stats
        const extensionStats = Object.entries(extensions)
            .map(([ext, val]) => ({
                ext,
                added: val.added,
                removed: val.removed,
                net: val.added - val.removed,
                touches: val.touches
            }))
            .sort((a, b) => (b.added + b.removed) - (a.added + a.removed));

        // Peak Day & Hour calculations
        let busiestDay = '-';
        let maxDayVal = 0;
        for (const [day, count] of Object.entries(dayStats)) {
            if (count > maxDayVal) {
                maxDayVal = count;
                busiestDay = `${day} (${count})`;
            }
        }

        let busiestHour = '-';
        let maxHourVal = 0;
        hourlyStats.forEach((count, h) => {
            if (count > maxHourVal) {
                maxHourVal = count;
                busiestHour = `${h}:00 (${count})`;
            }
        });

        const totalCommits = commitsList.length;
        const totalActiveDays = activeDays.size;

        res.json({
            author: config.author || 'All Authors',
            branch: targetBranch,
            rangeMode,
            totalCommits,
            totalActiveDays,
            commitsPerDay: totalActiveDays > 0 ? (totalCommits / totalActiveDays).toFixed(1) : 0,
            linesAdded: added,
            linesRemoved: removed,
            netDelta: added - removed,
            totalChurn: added + removed,
            avgCommitSize: totalCommits > 0 ? Math.round((added + removed) / totalCommits) : 0,
            retentionRate: (added + removed) > 0 ? Math.round(((added - removed) / (added + removed)) * 100) : 0,
            totalFilesTouched: allFiles.length,
            createdCount: newFiles.length,
            deletedCount: deletedFiles.length,
            busiestDay,
            busiestHour,
            weekdayCommits,
            weekendCommits,
            workHoursCommits,
            afterHoursCommits,
            sizeBuckets,
            biggestCommits,
            newFiles,
            deletedFiles,
            extensionStats,
            allFiles,
            dayStats,
            hourlyStats
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to process branch metrics.', details: err.message });
    }
});

// Front-End Application
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Stats</title>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                :root {
                    --bg: #f6f8fa; --card-bg: #ffffff; --border: #d0d7de;
                    --text: #1f2328; --text-muted: #656d76; --accent: #0969da;
                    --green: #1a7f37; --red: #cf222e; --btn: #1f883d; --btn-hover: #1a7f37;
                    --badge-new: #0969da; --badge-del: #cf222e;
                }
                * { box-sizing: border-box; }
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); padding: 2rem 1rem; margin: 0; }
                .container { max-width: 1240px; margin: 0 auto; }
                h1 { color: var(--text); font-size: 1.8rem; font-weight: 600; margin: 0 0 0.3rem 0; }
                .sub { color: var(--text-muted); margin-bottom: 1.5rem; font-size: 0.95rem; }
                .settings { background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; margin-bottom: 1rem; }
                .settings summary { cursor: pointer; padding: 0.75rem 1rem; color: var(--accent); font-weight: 600; }
                .settings-form { display: grid; grid-template-columns: minmax(240px, 2fr) minmax(180px, 1fr) minmax(140px, 1fr) auto; gap: 0.75rem; padding: 0 1rem 1rem; align-items: end; }
                .settings-form label { display: flex; flex-direction: column; gap: 0.35rem; }
                .settings-form input { width: 100%; }
                @media (max-width: 850px) { .settings-form { grid-template-columns: 1fr; } }
                .controls { background: var(--card-bg); padding: 1rem 1.25rem; border: 1px solid var(--border); border-radius: 6px; display: flex; align-items: center; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
                label { font-weight: 600; font-size: 0.85rem; color: var(--text-muted); }
                select, input { background: var(--card-bg); color: var(--text); border: 1px solid var(--border); padding: 8px 12px; border-radius: 6px; font-size: 0.9rem; outline: none; }
                select:focus, input:focus { border-color: var(--accent); }
                button { background: var(--btn); color: white; border: 1px solid rgba(31, 35, 40, 0.15); padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 0.9rem; transition: background 0.15s; }
                button:hover { background: var(--btn-hover); }
                .error-banner { background: #f8e4df; color: #7e2920; border: 1px solid #d59a90; padding: 1rem; border-radius: 2px; margin-bottom: 1.5rem; display: none; }
                
                .card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
                .card { background: var(--card-bg); padding: 1.15rem; border-radius: 6px; border: 1px solid var(--border); }
                .card h3 { margin: 0 0 0.4rem 0; font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
                .card p { margin: 0; font-size: 1.4rem; font-weight: 600; color: var(--text); }
                
                .add { color: var(--green) !important; }
                .del { color: var(--red) !important; }

                .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-bottom: 2rem; }
                @media (max-width: 850px) { .grid-2 { grid-template-columns: 1fr; } }
                
                .panel { background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; padding: 1.25rem; margin-bottom: 2rem; }
                .panel-title { font-size: 1rem; color: var(--text); font-weight: 600; margin-bottom: 1rem; display: flex; justify-content: space-between; align-items: center; }

                .bar-container { display: flex; align-items: flex-end; gap: 4px; height: 110px; padding-top: 10px; }
                .bar-wrapper { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; }
                .bar { width: 100%; background: var(--green); border-radius: 1px 1px 0 0; min-height: 2px; }
                .bar-label { font-size: 0.65rem; color: var(--text-muted); margin-top: 6px; }

                /* Bucket Distribution Bar */
                .bucket-row { display: flex; gap: 1rem; flex-wrap: wrap; margin-top: 0.5rem; }
                .bucket-item { flex: 1; min-width: 100px; background: var(--bg); border: 1px solid var(--border); padding: 0.75rem; border-radius: 2px; text-align: center; }
                .bucket-item .name { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; }
                .bucket-item .val { font-size: 1.2rem; font-weight: 600; color: var(--text); margin-top: 4px; }
                .bucket-item .subtext { font-size: 0.7rem; color: var(--text-muted); }

                table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 2px; overflow: hidden; font-size: 0.875rem; }
                th, td { padding: 0.65rem 0.9rem; text-align: left; border-bottom: 1px solid var(--border); }
                th { background: var(--bg); color: var(--text-muted); font-size: 0.78rem; text-transform: uppercase; cursor: pointer; user-select: none; }
                th:hover { color: var(--text); }
                code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 0.82rem; }
                
                .badge { font-size: 0.65rem; font-weight: 700; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; }
                .badge-created { background: var(--badge-new); color: #fff; }
                .badge-deleted { background: var(--badge-del); color: #fff; }
                .badge-modified { background: var(--border); color: var(--text-muted); }

                .table-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; gap: 1rem; flex-wrap: wrap; }
                .pagination { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; color: var(--text-muted); }
                .pagination button { padding: 4px 10px; font-size: 0.8rem; color: var(--text); background: var(--card-bg); border: 1px solid var(--border); }
                .pagination button:hover:not(:disabled) { background: var(--bg); }
                .pagination button:disabled { opacity: 0.4; cursor: not-allowed; }

                .tabs { display: flex; gap: 0.5rem; border-bottom: 1px solid var(--border); margin-bottom: 1rem; }
                .tab { padding: 8px 16px; font-size: 0.85rem; font-weight: 600; cursor: pointer; color: var(--text-muted); border-bottom: 2px solid transparent; }
                .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Stats</h1>
                <div class="sub">Author Profile: <strong id="author-profile">${TARGET_AUTHOR}</strong></div>

                <div id="error-banner" class="error-banner"></div>

                <details class="settings">
                    <summary>Repository settings</summary>
                    <div class="settings-form">
                        <label>Repository path<input id="repo-path" type="text" placeholder="C:\\path\\to\\repository"></label>
                        <label>Author<select id="author-name" onchange="updateAuthorProfile(this.value)"><option value="">All Authors</option></select></label>
                        <label>Base branch<input id="base-branch" type="text" placeholder="master"></label>
                        <button type="button" onclick="saveSettings()">Save settings</button>
                    </div>
                </details>

                <div class="controls">
                    <div>
                        <label for="branch-select">Branch:</label>
                        <select id="branch-select" onchange="handleBranchChange()">
                            <option value="--all">-- All Branches --</option>
                        </select>
                    </div>

                    <div>
                        <label for="range-select">View:</label>
                        <select id="range-select">
                            <option value="all">All-Time History</option>
                            <option value="diff-master" selected>New Commits vs. Base</option>
                            <option value="7days">Last 7 Days</option>
                            <option value="30days">Last 30 Days</option>
                            <option value="90days">Last 90 Days</option>
                        </select>
                    </div>

                    <button onclick="loadStats()">Run Analysis</button>
                    <span id="loading" style="display:none; color: #d29922; font-size: 0.9rem;">Processing commit graph...</span>
                </div>

                <!-- Primary KPIs -->
                <div class="card-grid">
                    <div class="card"><h3>Total Commits</h3><p id="commits">-</p></div>
                    <div class="card"><h3>Lines Added</h3><p id="added" class="add">-</p></div>
                    <div class="card"><h3>Lines Removed</h3><p id="removed" class="del">-</p></div>
                    <div class="card"><h3>Net Code Delta</h3><p id="net">-</p></div>
                    <div class="card"><h3>Avg / Commit</h3><p id="avg">-</p></div>
                    <div class="card"><h3>Files Touched</h3><p id="files-count">-</p></div>
                </div>

                <!-- Secondary / File Lifecycle KPIs -->
                <div class="card-grid">
                    <div class="card"><h3>New Files Created</h3><p id="new-files-count" class="add">-</p></div>
                    <div class="card"><h3>Files Deleted</h3><p id="del-files-count" class="del">-</p></div>
                    <div class="card"><h3>Active Days</h3><p id="active-days">-</p></div>
                    <div class="card"><h3>Velocity / Day</h3><p id="commits-per-day">-</p></div>
                    <div class="card"><h3>Code Retention</h3><p id="retention">-</p></div>
                    <div class="card"><h3>Peak Hour</h3><p id="busiest-hour">-</p></div>
                </div>

                <!-- Commit Size Distribution Histogram -->
                <div class="panel">
                    <div class="panel-title">Commit Size Distribution (Histogram)</div>
                    <div class="bucket-row">
                        <div class="bucket-item">
                            <div class="name">Micro</div>
                            <div class="val" id="b-micro">-</div>
                            <div class="subtext">&lt; 10 lines</div>
                        </div>
                        <div class="bucket-item">
                            <div class="name">Small</div>
                            <div class="val" id="b-small">-</div>
                            <div class="subtext">10 - 49 lines</div>
                        </div>
                        <div class="bucket-item">
                            <div class="name">Medium</div>
                            <div class="val" id="b-medium">-</div>
                            <div class="subtext">50 - 249 lines</div>
                        </div>
                        <div class="bucket-item">
                            <div class="name">Large</div>
                            <div class="val" id="b-large">-</div>
                            <div class="subtext">250 - 999 lines</div>
                        </div>
                        <div class="bucket-item">
                            <div class="name">Monolithic</div>
                            <div class="val" id="b-huge">-</div>
                            <div class="subtext">1000+ lines</div>
                        </div>
                    </div>
                </div>

                <!-- Punchcard Charts -->
                <div class="grid-2">
                    <div class="panel">
                        <div class="panel-title">Commit Activity by Hour of Day</div>
                        <div class="bar-container" id="hourly-chart"></div>
                    </div>
                    <div class="panel">
                        <div class="panel-title">Commit Activity by Day of Week</div>
                        <div class="bar-container" id="daily-chart"></div>
                    </div>
                </div>

                <!-- BIGGEST COMMITS LEADERBOARD -->
                <div class="panel">
                    <div class="panel-title">Top 15 Largest Commits (Ranked by Churn)</div>
                    <div style="overflow-x:auto;">
                        <table>
                            <thead>
                                <tr>
                                    <th style="width: 80px;">Commit</th>
                                    <th style="width: 110px;">Date</th>
                                    <th style="width: 80px;">Files</th>
                                    <th style="width: 100px;" class="add">Added</th>
                                    <th style="width: 100px;" class="del">Removed</th>
                                    <th style="width: 110px;">Total Churn</th>
                                    <th>Commit Message</th>
                                </tr>
                            </thead>
                            <tbody id="biggest-commits-table">
                                <tr><td colspan="7" style="color:var(--text-muted);">No commits recorded.</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- ALL FILES & NEW FILES TABS -->
                <div class="panel">
                    <div class="tabs">
                        <div class="tab active" id="tab-all" onclick="switchFileTab('all')">All Touched Files (<span id="count-all">0</span>)</div>
                        <div class="tab" id="tab-new" onclick="switchFileTab('new')">Brand New Files (<span id="count-new">0</span>)</div>
                        <div class="tab" id="tab-del" onclick="switchFileTab('del')">Deleted Files (<span id="count-del">0</span>)</div>
                    </div>

                    <div class="table-toolbar">
                        <div style="display:flex; align-items:center; gap:0.5rem;">
                            <input type="text" id="file-search" placeholder="Filter filenames..." oninput="filterFiles()" style="width: 280px;" />
                            <select id="page-size" onchange="changePageSize()">
                                <option value="15">15 per page</option>
                                <option value="50">50 per page</option>
                                <option value="100">100 per page</option>
                                <option value="999999">Show All</option>
                            </select>
                        </div>

                        <div class="pagination">
                            <button id="btn-prev" onclick="prevPage()">&laquo; Prev</button>
                            <span id="page-indicator">Page 1</span>
                            <button id="btn-next" onclick="nextPage()">Next &raquo;</button>
                        </div>
                    </div>

                    <div style="overflow-x:auto;">
                        <table>
                            <thead>
                                <tr>
                                    <th onclick="sortFiles('file')">File Path &#x21C5;</th>
                                    <th onclick="sortFiles('status')" style="width: 100px;">Status &#x21C5;</th>
                                    <th onclick="sortFiles('touches')" style="width: 90px;">Commits &#x21C5;</th>
                                    <th onclick="sortFiles('added')" style="width: 100px;" class="add">Added &#x21C5;</th>
                                    <th onclick="sortFiles('removed')" style="width: 100px;" class="del">Removed &#x21C5;</th>
                                    <th onclick="sortFiles('total')" style="width: 110px;">Total Churn &#x21C5;</th>
                                </tr>
                            </thead>
                            <tbody id="files-table-body">
                                <tr><td colspan="6" style="color:var(--text-muted);">No data.</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- Language / Extension Breakdown -->
                <div class="panel">
                    <div class="panel-title">Churn by File Extension</div>
                    <div style="overflow-x:auto;">
                        <table id="ext-table">
                            <thead>
                                <tr>
                                    <th>Extension</th>
                                    <th>Commits Touched</th>
                                    <th class="add">Lines Added</th>
                                    <th class="del">Lines Removed</th>
                                    <th>Net Delta</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr><td colspan="5" style="color:var(--text-muted);">No data available.</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <script>
                let dataset = { all: [], new: [], del: [] };
                let currentTab = 'all';
                let filteredFiles = [];
                let currentPage = 1;
                let pageSize = 15;
                let currentSort = { col: 'total', asc: false };
                const appDefaults = ${JSON.stringify({ repoPath: REPO_PATH, author: TARGET_AUTHOR, defaultBranch: DEFAULT_BRANCH })};

                function getSettings() {
                    const saved = JSON.parse(localStorage.getItem('devops-stats-settings') || '{}');
                    return {
                        repoPath: saved.repoPath || appDefaults.repoPath,
                        author: saved.author || appDefaults.author,
                        defaultBranch: saved.defaultBranch || appDefaults.defaultBranch
                    };
                }

                function settingsQuery(settings) {
                    return new URLSearchParams({
                        repoPath: settings.repoPath,
                        author: settings.author,
                        defaultBranch: settings.defaultBranch
                    }).toString();
                }

                async function loadAuthors(branch, selectedAuthor) {
                    const settings = getSettings();
                    const params = new URLSearchParams(settingsQuery(settings));
                    params.set('branch', branch || settings.defaultBranch);
                    const res = await fetch('/api/authors?' + params.toString());
                    const data = await res.json();
                    const select = document.getElementById('author-name');
                    select.innerHTML = '<option value="">All Authors</option>';
                    (data.authors || []).forEach(author => {
                        const option = document.createElement('option');
                        option.value = author;
                        option.textContent = author;
                        select.appendChild(option);
                    });
                    select.value = (data.authors || []).includes(selectedAuthor) ? selectedAuthor : '';
                    updateAuthorProfile(select.value);
                }

                function populateSettings() {
                    const settings = getSettings();
                    document.getElementById('repo-path').value = settings.repoPath;
                    document.getElementById('base-branch').value = settings.defaultBranch;
                    updateAuthorProfile(settings.author);
                }

                function updateAuthorProfile(author) {
                    document.getElementById('author-profile').textContent = author || 'All Authors';
                }

                function saveSettings() {
                    const settings = {
                        repoPath: document.getElementById('repo-path').value.trim(),
                        author: document.getElementById('author-name').value.trim(),
                        defaultBranch: document.getElementById('base-branch').value.trim()
                    };
                    localStorage.setItem('devops-stats-settings', JSON.stringify(settings));
                    updateAuthorProfile(settings.author);
                    initBranches();
                }

                async function handleBranchChange() {
                    try {
                        const branch = document.getElementById('branch-select').value;
                        await loadAuthors(branch, getSettings().author);
                        loadStats();
                    } catch (err) {
                        showError('Failed to load authors from the selected branch.');
                    }
                }

                async function initBranches() {
                    try {
                        const settings = getSettings();
                        const res = await fetch('/api/branches?' + settingsQuery(settings));
                        const data = await res.json();
                        const select = document.getElementById('branch-select');

                        if (data.branches) {
                            data.branches.forEach(branch => {
                                const opt = document.createElement('option');
                                opt.value = branch;
                                opt.textContent = branch;
                                select.appendChild(opt);
                            });
                        }
                        select.value = data.defaultBranch;
                        document.getElementById('range-select').value = 'diff-master';
                        await loadAuthors(select.value, getSettings().author);
                        loadStats();
                    } catch (err) {
                        showError('Failed to load branches from repository.');
                    }
                }

                function showError(msg) {
                    const banner = document.getElementById('error-banner');
                    banner.textContent = msg;
                    banner.style.display = 'block';
                }

                function clearError() {
                    document.getElementById('error-banner').style.display = 'none';
                }

                async function loadStats() {
                    clearError();
                    const settings = { ...getSettings(), author: document.getElementById('author-name').value };
                    const branch = document.getElementById('branch-select').value;
                    const range = document.getElementById('range-select').value;
                    document.getElementById('loading').style.display = 'inline';

                    try {
                        const params = new URLSearchParams(settingsQuery(settings));
                        params.set('branch', branch);
                        params.set('range', range);
                        const res = await fetch('/api/stats?' + params.toString());
                        const data = await res.json();
                        document.getElementById('loading').style.display = 'none';

                        if (data.error) {
                            showError(data.details || data.error);
                            return;
                        }

                        // Primary KPIs
                        document.getElementById('commits').textContent = data.totalCommits.toLocaleString();
                        document.getElementById('added').textContent = '+' + data.linesAdded.toLocaleString();
                        document.getElementById('removed').textContent = '-' + data.linesRemoved.toLocaleString();
                        document.getElementById('net').textContent = (data.netDelta > 0 ? '+' : '') + data.netDelta.toLocaleString();
                        document.getElementById('avg').textContent = data.avgCommitSize.toLocaleString() + ' lines';
                        document.getElementById('files-count').textContent = data.totalFilesTouched.toLocaleString();

                        // Extended KPIs
                        document.getElementById('new-files-count').textContent = data.createdCount.toLocaleString();
                        document.getElementById('del-files-count').textContent = data.deletedCount.toLocaleString();
                        document.getElementById('active-days').textContent = data.totalActiveDays.toLocaleString() + ' days';
                        document.getElementById('commits-per-day').textContent = data.commitsPerDay + ' / day';
                        document.getElementById('retention').textContent = data.retentionRate + '%';
                        document.getElementById('busiest-hour').textContent = data.busiestHour;

                        // Size Buckets
                        document.getElementById('b-micro').textContent = data.sizeBuckets.micro.toLocaleString();
                        document.getElementById('b-small').textContent = data.sizeBuckets.small.toLocaleString();
                        document.getElementById('b-medium').textContent = data.sizeBuckets.medium.toLocaleString();
                        document.getElementById('b-large').textContent = data.sizeBuckets.large.toLocaleString();
                        document.getElementById('b-huge').textContent = data.sizeBuckets.huge.toLocaleString();

                        // Hourly Bar Chart
                        const maxHour = Math.max(...data.hourlyStats, 1);
                        document.getElementById('hourly-chart').innerHTML = data.hourlyStats.map((count, hour) => {
                            const pct = (count / maxHour) * 100;
                            return \`
                                <div class="bar-wrapper" title="\${hour}:00 - \${count} commits">
                                    <div class="bar" style="height: \${pct}%;"></div>
                                    <div class="bar-label">\${hour}</div>
                                </div>
                            \`;
                        }).join('');

                        // Daily Bar Chart
                        const maxDay = Math.max(...Object.values(data.dayStats), 1);
                        document.getElementById('daily-chart').innerHTML = Object.entries(data.dayStats).map(([day, count]) => {
                            const pct = (count / maxDay) * 100;
                            return \`
                                <div class="bar-wrapper" title="\${day} - \${count} commits">
                                    <div class="bar" style="height: \${pct}%; background: #1f6beb;"></div>
                                    <div class="bar-label">\${day}</div>
                                </div>
                            \`;
                        }).join('');

                        // Biggest Commits Table
                        document.getElementById('biggest-commits-table').innerHTML = data.biggestCommits.length > 0
                            ? data.biggestCommits.map(c => \`
                                <tr>
                                    <td><code>\${c.hash}</code></td>
                                    <td style="color:var(--text-muted); font-size:0.8rem;">\${c.date}</td>
                                    <td>\${c.filesCount}</td>
                                    <td class="add">+\${c.added.toLocaleString()}</td>
                                    <td class="del">-\${c.removed.toLocaleString()}</td>
                                    <td><strong>\${c.total.toLocaleString()}</strong></td>
                                    <td style="word-break:break-word;">\${c.message}</td>
                                </tr>
                            \`).join('')
                            : '<tr><td colspan="7" style="color:var(--text-muted);">No commits found.</td></tr>';

                        // Extension Breakdown Table
                        document.getElementById('ext-table').querySelector('tbody').innerHTML = data.extensionStats.length > 0
                            ? data.extensionStats.map(e => \`
                                <tr>
                                    <td><code>\${e.ext}</code></td>
                                    <td>\${e.touches.toLocaleString()}</td>
                                    <td class="add">+\${e.added.toLocaleString()}</td>
                                    <td class="del">-\${e.removed.toLocaleString()}</td>
                                    <td><strong>\${(e.net > 0 ? '+' : '') + e.net.toLocaleString()}</strong></td>
                                </tr>
                            \`).join('')
                            : '<tr><td colspan="5" style="color:var(--text-muted);">No extension data.</td></tr>';

                        // Cache datasets
                        dataset.all = data.allFiles;
                        dataset.new = data.newFiles;
                        dataset.del = data.deletedFiles;

                        document.getElementById('count-all').textContent = dataset.all.length.toLocaleString();
                        document.getElementById('count-new').textContent = dataset.new.length.toLocaleString();
                        document.getElementById('count-del').textContent = dataset.del.length.toLocaleString();

                        switchFileTab(currentTab);

                    } catch (err) {
                        document.getElementById('loading').style.display = 'none';
                        showError('Network error connecting to Express server.');
                    }
                }

                function switchFileTab(tabName) {
                    currentTab = tabName;
                    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                    document.getElementById('tab-' + tabName).classList.add('active');

                    filterFiles();
                }

                function filterFiles() {
                    const q = document.getElementById('file-search').value.toLowerCase().trim();
                    const source = dataset[currentTab] || [];
                    filteredFiles = source.filter(f => f.file.toLowerCase().includes(q));
                    currentPage = 1;
                    renderFilesTable();
                }

                function sortFiles(col) {
                    if (currentSort.col === col) {
                        currentSort.asc = !currentSort.asc;
                    } else {
                        currentSort.col = col;
                        currentSort.asc = (col === 'file' || col === 'status');
                    }

                    filteredFiles.sort((a, b) => {
                        let vA = a[col];
                        let vB = b[col];
                        if (typeof vA === 'string') {
                            return currentSort.asc ? vA.localeCompare(vB) : vB.localeCompare(vA);
                        }
                        return currentSort.asc ? vA - vB : vB - vA;
                    });

                    renderFilesTable();
                }

                function changePageSize() {
                    pageSize = parseInt(document.getElementById('page-size').value, 10);
                    currentPage = 1;
                    renderFilesTable();
                }

                function prevPage() {
                    if (currentPage > 1) {
                        currentPage--;
                        renderFilesTable();
                    }
                }

                function nextPage() {
                    if ((currentPage * pageSize) < filteredFiles.length) {
                        currentPage++;
                        renderFilesTable();
                    }
                }

                function renderFilesTable() {
                    const start = (currentPage - 1) * pageSize;
                    const pageItems = filteredFiles.slice(start, start + pageSize);

                    const totalPages = Math.ceil(filteredFiles.length / pageSize) || 1;
                    document.getElementById('page-indicator').textContent = \`Page \${currentPage} of \${totalPages}\`;
                    document.getElementById('btn-prev').disabled = (currentPage === 1);
                    document.getElementById('btn-next').disabled = (currentPage >= totalPages);

                    const tbody = document.getElementById('files-table-body');
                    if (pageItems.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text-muted);">No matching files found.</td></tr>';
                        return;
                    }

                    tbody.innerHTML = pageItems.map(f => {
                        let badgeClass = 'badge-modified';
                        if (f.status === 'CREATED') badgeClass = 'badge-created';
                        if (f.status === 'DELETED') badgeClass = 'badge-deleted';

                        return \`
                            <tr>
                                <td><code>\${f.file}</code></td>
                                <td><span class="badge \${badgeClass}">\${f.status}</span></td>
                                <td>\${f.touches.toLocaleString()}</td>
                                <td class="add">+\${f.added.toLocaleString()}</td>
                                <td class="del">-\${f.removed.toLocaleString()}</td>
                                <td><strong>\${f.total.toLocaleString()}</strong></td>
                            </tr>
                        \`;
                    }).join('');
                }

                window.onload = () => {
                    populateSettings();
                    initBranches();
                };
            </script>
        </body>
        </html>
    `);
});

app.listen(PORT, () => console.log(`Dashboard running at http://localhost:${PORT}`));