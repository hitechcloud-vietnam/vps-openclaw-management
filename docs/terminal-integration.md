# Integrating Terminal Widget into Laravel

A small component embedded into a Laravel system. `mgmt_url` and `mgmt_key` are passed from the parent component — each user has their own VPS and key.

---

## Security Architecture

```
Parent component
  │  :mgmt-url="$user->vps_url"  :mgmt-key="$user->mgmt_key"
  ▼
TerminalWidget::mount($mgmtUrl, $mgmtKey)
  │  session['oc_term_<uuid>'] = ['url' => ..., 'key' => ...]
  │  returns $sessionKey = uuid  ← safe, just an identifier
  ▼
Browser EventSource  →  /terminal/stream?session=<uuid>&cmd=...
  ▼
TerminalProxyController  →  fetches url/key from session  → proxies to VPS
```

> `mgmt_key` is kept **server-side in the session**, never appears in HTML or JS sent to the browser.

---

## SSE Event Format

```
data: {"type":"stdout","text":"NAME   STATUS\n"}
data: {"type":"stderr","text":"Warning: ...\n"}
data: {"type":"error","text":"Command not allowed"}
data: {"type":"exit","code":0}
```

---

## Allowed Commands

| Group      | Commands                                                                       |
|------------|--------------------------------------------------------------------------------|
| Systemd    | `systemctl status/restart/stop/start openclaw` · `systemctl status/restart caddy` |
| Journalctl | `journalctl -u openclaw` · `journalctl -u caddy`                               |
| OpenClaw CLI | `openclaw <cmd>` · `claw <cmd>`                                              |
| System     | `df` · `free` · `uptime` · `ps` · `date` · `hostname` · `uname`                |

The following shell metacharacters are blocked: `` ; & | ` $ ( ) { } \ ! ' " < > ``

---

## 1. Route

```php
// routes/web.php
use App\Http\Controllers\TerminalProxyController;

Route::middleware(['auth'])->group(function () {
    Route::get('/terminal/stream', [TerminalProxyController::class, 'stream'])
        ->name('terminal.stream');
});
```

**Exempt CSRF** — `EventSource` uses GET and cannot send CSRF tokens:

```php
// app/Http/Middleware/VerifyCsrfToken.php
protected $except = [
    'terminal/stream',
];
```

---

## 2. Proxy Controller

```php
<?php
// app/Http/Controllers/TerminalProxyController.php

namespace App\Http\Controllers;

use Illuminate\Http\Request;

class TerminalProxyController extends Controller
{
    public function stream(Request $request)
    {
        // Get credentials from session — key never goes to browser
        $sessionKey = $request->query('session', '');
        $creds = session('oc_term_' . $sessionKey);

        if (!$creds || empty($creds['url']) || empty($creds['key'])) {
            abort(403, 'Invalid or expired terminal session');
        }

        $cmd = $request->query('cmd', '');

        if (empty($cmd) || preg_match('/[;&|`$(){}\\\\!\'"<>]/', $cmd)) {
            abort(400, 'Invalid command');
        }

        $upstreamUrl = rtrim($creds['url'], '/')
            . '/api/terminal/stream?cmd=' . urlencode($cmd)
            . '&token=' . urlencode($creds['key']);

        return response()->stream(function () use ($upstreamUrl) {
            $ch = curl_init($upstreamUrl);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => false,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_TIMEOUT        => 120,
                CURLOPT_WRITEFUNCTION  => function ($ch, $data) {
                    echo $data;
                    ob_flush();
                    flush();
                    return strlen($data);
                },
            ]);
            curl_exec($ch);
            curl_close($ch);
        }, 200, [
            'Content-Type'      => 'text/event-stream',
            'Cache-Control'     => 'no-cache',
            'X-Accel-Buffering' => 'no',
            'Connection'        => 'keep-alive',
        ]);
    }
}
```

---

## 3. Livewire Component

```php
<?php
// app/Livewire/TerminalWidget.php

namespace App\Livewire;

use Livewire\Component;
use Livewire\Attributes\Locked;
use Illuminate\Support\Str;

class TerminalWidget extends Component
{
    // sessionKey is UUID — safe to expose to JS
    #[Locked]
    public string $sessionKey = '';

    public array $quickCmds = [
        ['label' => 'status',      'cmd' => 'systemctl status openclaw caddy'],
        ['label' => 'logs',        'cmd' => 'journalctl -u openclaw --no-pager -n 80'],
        ['label' => 'logs -f',     'cmd' => 'journalctl -u openclaw -f'],
        ['label' => 'restart',     'cmd' => 'systemctl restart openclaw'],
        ['label' => 'upgrade',     'cmd' => 'npm update -g openclaw@latest'],
        ['label' => 'caddy logs',  'cmd' => 'journalctl -u caddy --no-pager -n 30'],
        ['label' => 'df',          'cmd' => 'df -h'],
        ['label' => 'free',        'cmd' => 'free -h'],
        ['label' => 'uptime',      'cmd' => 'uptime'],
        ['label' => 'models scan', 'cmd' => 'openclaw models scan'],
        ['label' => 'channels',    'cmd' => 'openclaw channels list'],
        ['label' => 'version',     'cmd' => 'openclaw version'],
    ];

    /**
     * @param string $mgmtUrl  VPS Management API URL, e.g., http://103.142.25.188:9998
     * @param string $mgmtKey  User's Management API key
     */
    public function mount(string $mgmtUrl, string $mgmtKey): void
    {
        $this->sessionKey = (string) Str::uuid();

        // Store credentials in session — never goes to browser
        session([
            'oc_term_' . $this->sessionKey => [
                'url' => $mgmtUrl,
                'key' => $mgmtKey,
            ],
        ]);
    }

    public function render()
    {
        return view('livewire.terminal-widget');
    }
}
```

---

## 4. Blade View

```blade
{{-- resources/views/livewire/terminal-widget.blade.php --}}

<div class="flex flex-col bg-[#0d1117] rounded-xl overflow-hidden border border-[#30363d]"
     style="height:560px">

    {{-- Quick commands --}}
    <div id="oc-qbar-{{ $sessionKey }}"
         class="flex items-center gap-1 px-3 py-1.5 bg-[#161b22] border-b border-[#21262d] shrink-0 overflow-x-auto">
        <span class="text-[11px] text-[#484f58] mr-1 shrink-0">Quick:</span>
        @foreach($quickCmds as $qc)
            <button class="oc-qbtn shrink-0 px-2 py-0.5 bg-[#0d1117] border border-[#21262d]
                           rounded text-[#8b949e] text-xs hover:text-white hover:border-[#58a6ff]
                           transition-colors cursor-pointer"
                    data-cmd="{{ $qc['cmd'] }}">
                {{ $qc['label'] }}
            </button>
        @endforeach
    </div>

    {{-- wire:ignore — required, prevents Livewire from deleting xterm.js DOM --}}
    <div wire:ignore class="flex-1 overflow-hidden p-1">
        <div id="oc-terminal-{{ $sessionKey }}"></div>
    </div>

    {{-- Only pass sessionKey (UUID) to JS — never the real key --}}
    @script
    <script>
        initOcTerminal({
            termId:     'oc-terminal-{{ $sessionKey }}',
            qbarId:     'oc-qbar-{{ $sessionKey }}',
            streamUrl:  @json(route('terminal.stream')),
            sessionKey: @json($sessionKey),
        });
    </script>
    @endscript

</div>
```

---

## 5. JavaScript

```js
// resources/js/terminal-widget.js
// Supports multiple instances on the same page

function initOcTerminal({ termId, qbarId, streamUrl, sessionKey }) {
    const stateKey = 'oc_init_' + sessionKey;
    if (window[stateKey]) return;   // prevent double init on Livewire re-render
    window[stateKey] = true;

    const HIST_KEY = 'oc_term_hist';

    function loadCss(href) {
        if (document.querySelector(`link[href="${href}"]`)) return;
        const l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = href;
        document.head.appendChild(l);
    }
    function loadScript(src, cb) {
        if (window['_sc_' + src]) { cb(); return; }
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => { window['_sc_' + src] = true; cb(); };
        document.head.appendChild(s);
    }

    loadCss('https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css');
    loadScript('https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js', () => {
        loadScript('https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js', boot);
    });

    function boot() {
        const term = new Terminal({
            cursorBlink: true,
            fontFamily:  '"Cascadia Code","JetBrains Mono","Courier New",monospace',
            fontSize: 14, lineHeight: 1.3, scrollback: 5000,
            theme: {
                background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff',
                selectionBackground: '#264f78',
                black:   '#484f58', red:     '#f85149', green:   '#3fb950', yellow:  '#d29922',
                blue:    '#58a6ff', magenta: '#bc8cff', cyan:    '#76e3ea', white:   '#b1bac4',
                brightBlack: '#6e7681', brightRed: '#ff7b72', brightGreen:   '#56d364',
                brightYellow: '#e3b341', brightBlue: '#79c0ff',
            },
        });

        const fit = new FitAddon.FitAddon();
        term.loadAddon(fit);
        term.open(document.getElementById(termId));
        fit.fit();
        window.addEventListener('resize', () => fit.fit());

        let buf = '', hist = [], hidx = -1, running = false, sse = null;
        try { hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch {}

        const prompt  = () => term.write('\x1b[32m$\x1b[0m ');
        const killSSE = () => { sse?.close(); sse = null; running = false; };
        const clrBuf  = () => { if (buf.length) term.write('\b \b'.repeat(buf.length)); buf = ''; };

        function execCmd(cmd) {
            running = true;
            // sessionKey replaces mgmt_key — Laravel looks up in session
            const url = streamUrl + '?session=' + encodeURIComponent(sessionKey)
                                  + '&cmd='     + encodeURIComponent(cmd);
            sse = new EventSource(url);

            sse.onmessage = (ev) => {
                try {
                    const d = JSON.parse(ev.data);
                    if (d.type === 'stdout')
                        term.write(d.text.replace(/\n/g, '\r\n').replace(/\r\r\n/g, '\r\n'));
                    else if (d.type === 'stderr')
                        term.write('\x1b[33m' + d.text.replace(/\n/g, '\r\n') + '\x1b[0m');
                    else if (d.type === 'error') {
                        term.write('\x1b[31m' + d.text + '\x1b[0m\r\n');
                        killSSE(); prompt();
                    } else if (d.type === 'exit') {
                        if (d.code) term.write('\r\n\x1b[2m[exit ' + d.code + ']\x1b[0m');
                        term.write('\r\n');
                        killSSE(); prompt();
                    }
                } catch {}
            };

            sse.onerror = () => {
                term.write('\r\n\x1b[31m[stream error]\x1b[0m\r\n');
                killSSE(); prompt();
            };
        }

        term.onKey(({ key, domEvent: e }) => {
            if (running) {
                if (e.ctrlKey && e.key === 'c') { killSSE(); term.write('^C\r\n'); prompt(); }
                return;
            }
            if (e.ctrlKey) { if (e.key === 'l') { term.clear(); prompt(); } return; }

            if (e.key === 'Enter') {
                const cmd = buf.trim(); term.write('\r\n'); buf = ''; hidx = -1;
                if (cmd) {
                    if (!hist.length || hist[0] !== cmd) {
                        hist.unshift(cmd);
                        if (hist.length > 200) hist.pop();
                        try { localStorage.setItem(HIST_KEY, JSON.stringify(hist)); } catch {}
                    }
                    execCmd(cmd);
                } else { prompt(); }
            } else if (e.key === 'Backspace') {
                if (buf.length) { buf = buf.slice(0, -1); term.write('\b \b'); }
            } else if (e.key === 'ArrowUp') {
                if (hidx < hist.length - 1) { hidx++; clrBuf(); buf = hist[hidx]; term.write(buf); }
            } else if (e.key === 'ArrowDown') {
                if (hidx > 0) { hidx--; clrBuf(); buf = hist[hidx]; term.write(buf); }
                else if (hidx === 0) { hidx = -1; clrBuf(); }
            } else if (!e.altKey && !e.metaKey && key.length === 1) {
                buf += key; term.write(key);
            }
        });

        // Quick-command buttons
        document.getElementById(qbarId)?.addEventListener('click', (e) => {
            const btn = e.target.closest('.oc-qbtn');
            if (!btn) return;
            if (running) killSSE();
            clrBuf();
            term.write('\x1b[32m$\x1b[0m ' + btn.dataset.cmd + '\r\n');
            execCmd(btn.dataset.cmd);
        });

        term.write('\x1b[1;34m OpenClaw Terminal\x1b[0m\r\n');
        term.write('\x1b[2m Ctrl+C = cancel  |  Ctrl+L = clear\x1b[0m\r\n\r\n');
        prompt();
    }
}

window.initOcTerminal = initOcTerminal;
```

Import it in your `app.js`:

```js
import './terminal-widget.js';
```

---

## 6. Use from Parent Component

```blade
{{-- Parent passes url and key per user --}}
<livewire:terminal-widget
    :mgmt-url="$server->mgmt_api_url"
    :mgmt-key="$server->mgmt_api_key"
/>
```

Supports multiple widget instances on a single page (each has its own `sessionKey` and `termId`):

```blade
@foreach($user->servers as $server)
    <livewire:terminal-widget
        :mgmt-url="$server->mgmt_api_url"
        :mgmt-key="$server->mgmt_api_key"
        :key="$server->id"
    />
@endforeach
```

---

## 7. Nginx — disable buffering for SSE

```nginx
location /terminal/stream {
    fastcgi_buffering off;
    proxy_buffering   off;
    proxy_read_timeout 120s;
}
```

---

## Troubleshooting

**`403 Invalid or expired terminal session`**
Session has expired. Reload the page to generate a new session.

**`[stream error]` when running commands**
Check if `mgmt_url` is correct and port 9998 on the VPS is open.

**Terminal disappears after Livewire re-render**
Missing `wire:ignore`. Confirm Step 4.

**No stream output (buffered)**
Add at the top of the `stream()` method:
```php
if (ob_get_level()) ob_end_clean();
```