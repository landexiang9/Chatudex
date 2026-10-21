// Real public HTTP + isolated filing file; never initializes personal config/DB/credentials.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {spawn} = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const assert = require('assert/strict');
const fixture = String.raw`
import json, sys, tempfile, threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from claude_chat import site_info
from claude_chat.server import ThreadingHTTPServer, ClaudeChatHTTPHandler
with tempfile.TemporaryDirectory(prefix='site-info-qa-') as directory:
    config_path = Path(directory) / 'site_info.json'
    config_path.write_text('{"filings":[]}', encoding='utf-8')
    with patch.object(site_info, 'SITE_INFO_PATH', config_path):
        app = SimpleNamespace(config={'security_token':'test-token'})
        server = ThreadingHTTPServer(('127.0.0.1', 0), ClaudeChatHTTPHandler, app, object())
        worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
        print(json.dumps({'port':server.server_port, 'configPath':str(config_path)}), flush=True)
        try: sys.stdin.read()
        finally: server.shutdown(); server.server_close(); worker.join(timeout=3)
`;

(async () => {
    const server = spawn(process.env.PYTHON_EXECUTABLE || '.venv/Scripts/python.exe', ['-u','-c',fixture], {
        cwd:process.cwd(), stdio:['pipe','pipe','pipe'], env:{...process.env,PYTHONIOENCODING:'utf-8'}
    });
    let browser, diagnostics = '';
    server.stderr.on('data', chunk => diagnostics += chunk);
    try {
        const {port, configPath} = await new Promise((resolve,reject) => {
            let text = '';
            const timer = setTimeout(() => reject(new Error('Fixture timeout: '+diagnostics)), 15000);
            server.stdout.on('data', chunk => {
                text += chunk;
                const line = text.split('\n').find(row => row.startsWith('{"port"'));
                if (line) { clearTimeout(timer); resolve(JSON.parse(line)); }
            });
            server.on('exit', code => { clearTimeout(timer); reject(new Error('Fixture exit '+code+': '+diagnostics)); });
        });
        browser = await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
        const page = await browser.newPage({viewport:{width:1280,height:900}});
        const errors = [], publicHeaders = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => { if (request.url().endsWith('/site-info.json')) publicHeaders.push(request.headers()); });
        await page.addInitScript(() => localStorage.setItem('security_token', 'stale-token'));
        const base = `http://127.0.0.1:${port}`;
        await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
        const output = path.join(process.cwd(),'scratch','site-info-review'); await fs.mkdir(output,{recursive:true});
        const capture = name => page.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});
        const initialInfo = page.waitForResponse(response => response.url().endsWith('/site-info.json'));
        await page.goto(base);
        await page.locator('#auth-token-input').waitFor();
        await initialInfo;
        assert.equal(await page.locator('#sidebar-site-info').textContent(),'本地会话 · 密钥加密');
        assert(await page.locator('#auth-site-info').isHidden());
        await capture('empty-auth');

        const text = '<img src=x onerror=alert(1)> 示例备案号';
        const entries = [{text,url:'https://example.com/filing'},{text:'示例公安备案号',url:'https://example.com/security'}];
        await fs.writeFile(configPath, JSON.stringify({filings:entries,secret:'never-publish'}));
        // Deliver public information after the auth dialog opens, covering their startup race.
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        await page.route(base+'/site-info.json', async route => { await gate; await route.continue(); });
        await page.reload({waitUntil:'domcontentloaded'});
        await page.locator('#auth-token-input').waitFor();
        release();
        await page.waitForFunction(() => document.querySelectorAll('#auth-site-info a').length === 2);
        for (const selector of ['#sidebar-site-info','#auth-site-info']) {
            assert.deepEqual(await page.locator(selector+' a').allTextContents(), entries.map(item=>item.text));
            assert.equal(await page.locator(selector+' img').count(),0);
            assert.equal(await page.locator(selector+' a').first().getAttribute('href'),entries[0].url);
            assert.equal(await page.locator(selector+' a').first().getAttribute('rel'),'noopener noreferrer');
        }
        assert.equal((await page.request.get(base+'/api/config')).status(),401);
        assert.deepEqual(await (await page.request.get(base+'/site-info.json')).json(),{filings:entries});
        const assertAuthFooter = async () => {
            const footer=await page.locator('#auth-site-info').boundingBox();
            const card=await page.locator('.auth-card').boundingBox();
            const button=await page.locator('#auth-submit-btn').boundingBox();
            assert(Math.abs(footer.x+footer.width/2-card.x-card.width/2)<2,'Filing is centered in card');
            assert(footer.y>=button.y+button.height,'Filing sits below connect button');
            assert(footer.y+footer.height<card.y+card.height,'Filing stays inside authentication card');
            assert.equal(await page.locator('.auth-footer #auth-site-info').count(),1);
            return page.locator('#auth-site-info a').first().evaluate(link => {
                const rgb = value => value.match(/[\d.]+/g).slice(0,3).map(Number);
                const luminance = value => rgb(value).map(channel => {
                    const n=channel/255; return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;
                }).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
                const color=getComputedStyle(link).color;
                const background=getComputedStyle(link.closest('.auth-card')).backgroundColor;
                const [high,low]=[luminance(color),luminance(background)].sort((a,b)=>b-a);
                return {color,contrast:(high+.05)/(low+.05)};
            });
        };
        await page.evaluate(() => ChatTheme.set('light'));
        const light=await assertAuthFooter();
        assert(light.contrast>=4.5,'Light-theme filing remains readable');
        await page.locator('#auth-token-input').focus(); await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.id),'auth-submit-btn');
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.textContent),text);
        await capture('configured-auth');
        await page.setViewportSize({width:390,height:844});
        await page.evaluate(() => ChatTheme.set('dark'));
        const dark=await assertAuthFooter();
        assert(dark.contrast>=4.5,'Dark-theme filing remains readable');
        assert.notEqual(dark.color,light.color);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await capture('mobile-auth-dark');
        await page.setViewportSize({width:390,height:500});
        await assertAuthFooter();
        await page.emulateMedia({colorScheme:'light'});
        await page.evaluate(() => ChatTheme.set('system'));
        assert.equal((await assertAuthFooter()).color,light.color);
        await page.emulateMedia({colorScheme:'dark'});
        await page.waitForFunction(() => document.documentElement.dataset.theme==='dark');
        assert.equal((await assertAuthFooter()).color,dark.color);
        await page.setViewportSize({width:390,height:844});
        await page.evaluate(() => {
            document.getElementById('auth-overlay').remove();
            const shell=document.querySelector('.app-container'); shell.inert=false; shell.removeAttribute('aria-hidden');
            shell.classList.add('sidebar-open');
        });
        assert(await page.locator('#sidebar-site-info a').first().isVisible());
        await capture('mobile-sidebar-dark');
        await page.setViewportSize({width:1280,height:900});
        await page.evaluate(() => ChatTheme.set('light')); await capture('desktop-sidebar');
        await page.unroute(base+'/site-info.json');
        await fs.writeFile(configPath, '{invalid');
        await page.reload(); await page.locator('#auth-token-input').waitFor();
        await page.waitForFunction(() => document.getElementById('sidebar-site-info').textContent === '本地会话 · 密钥加密');
        assert(await page.locator('#auth-site-info').isHidden());
        assert(publicHeaders.length > 0);
        assert(publicHeaders.every(headers => !headers['x-security-token'] && !headers.authorization));
        assert.deepEqual(errors,[]);
        console.log('Site filing QA passed: default, invalid config, public-before-auth race, safe links/text, auth protection, keyboard, light/dark/mobile.');
    } finally {
        if (browser) await browser.close();
        server.stdin.end();
    }
})().catch(error => { console.error(error); process.exitCode=1; });
