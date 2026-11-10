#!/usr/bin/env python3
"""Isolated real Sparkle install tests. Requires macOS, cryptography, and official Sparkle 2.10.1.

Never launches the project's runtime or Codex owner. Test applications have unique
bundle IDs, a shell stub runtime, and test-only HTTP ATS exceptions. The production
termination handshake is preserved; only UI presentation and the user driver are
replaced. Signing keys live only in this process and official sign_update stdin.
"""
import base64, functools, http.server, json, os, pathlib, plistlib, re, shutil, signal, subprocess, tempfile, threading, time, uuid
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, PublicFormat, NoEncryption

ROOT=pathlib.Path(__file__).resolve().parent.parent
WORK=pathlib.Path(tempfile.mkdtemp(prefix='codex-updater-integration-'))
DIST=pathlib.Path(os.environ['CODEX_PHONE_SPARKLE_DIST']).resolve()
assert plistlib.load((DIST/'Sparkle.framework/Resources/Info.plist').open('rb'))['CFBundleShortVersionString']=='2.10.1'
SERVER=WORK/'server'; SERVER.mkdir()
class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt,*args):
        with (WORK/'http.log').open('a') as f: f.write(fmt%args+'\n')
httpd=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(SERVER)))
threading.Thread(target=httpd.serve_forever,daemon=True).start()
port=httpd.server_port
key=Ed25519PrivateKey.generate()
seed=base64.b64encode(key.private_bytes(Encoding.Raw,PrivateFormat.Raw,NoEncryption()))
public=base64.b64encode(key.public_key().public_bytes(Encoding.Raw,PublicFormat.Raw)).decode()

def run(args, **kwargs):
    return subprocess.run(args,check=True,capture_output=True,text=True,**kwargs).stdout

def sign(path, signing_seed=seed):
    return subprocess.run([str(DIST/'bin/sign_update'),'--ed-key-file','-','-p',str(path)],input=signing_seed+b'\n',capture_output=True,check=True).stdout.decode().strip()

def waitfor(fn, timeout=35):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        result=fn()
        if result: return result
        time.sleep(.15)
    raise AssertionError('timeout')

def events(base):
    p=base/'events.log'
    return p.read_text() if p.exists() else ''

source=(ROOT/'macos/CodexHub.swift').read_text()
source=source.replace('private var updaterController: SPUStandardUpdaterController?', 'private var updaterController: SPUStandardUpdaterController?\n    private var integrationUpdater: SPUUpdater?\n    private let integrationDriver = IntegrationUserDriver()')
a=source.index('    private func configureUpdater(in menu: NSMenu) {')
b=source.index('    @objc private func toggleAutomaticUpdateChecks',a)
source=source[:a]+'''    private func configureUpdater(in menu: NSMenu) {
        testLog("launch:\\(ProcessInfo.processInfo.processIdentifier):\\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion")!)")
        Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in
            let stop = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("finish-test")
            if FileManager.default.fileExists(atPath: stop.path) { NSApp.terminate(nil) }
        }
        if Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String == "2" {
            testLog("launched-version-2")
            return
        }
        let updater = SPUUpdater(hostBundle: Bundle.main, applicationBundle: Bundle.main, userDriver: integrationDriver, delegate: nil)
        integrationUpdater = updater
        do { try updater.start() } catch { testLog("startup-error:\\(error)"); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { updater.checkForUpdates() }
    }

'''+source[b:]
source=source.replace('window.makeKeyAndOrderFront(nil)','window.orderOut(nil)').replace('NSApp.activate(ignoringOtherApps: true)','// Test app does not take focus')
source=source.replace('alert.beginSheetModal(for: window)', 'testLog("quit-blocked")')
assert 'self.terminationWaitAlert = alert' in source, 'Production Swift must keep waiting after the 15-second notification'
source=source.replace('self.terminationWaitAlert = alert', 'self.terminationWaitAlert = alert; testLog("wait-alert-shown")')
source=source.replace('window.endSheet(alert.window); terminationWaitAlert = nil', 'window.endSheet(alert.window); terminationWaitAlert = nil; testLog("wait-alert-dismissed")')
source=source.replace('self.recordRuntimeExit(child, at: exitedAt, stderrTail: tail)', 'testLog("unexpected-runtime-exit"); self.recordRuntimeExit(child, at: exitedAt, stderrTail: tail)')
source=source.replace('if self.terminationRequested { NSApp.reply(toApplicationShouldTerminate: true) }','if self.terminationRequested { testLog("runtime-exited-approved"); NSApp.reply(toApplicationShouldTerminate: true) }')
(WORK/'CodexHub.swift').write_text(source)
run(['swiftc','-target','arm64-apple-macosx12.0',str(WORK/'CodexHub.swift'),str(ROOT/'macos/UpdateConfiguration.swift'),str(ROOT/'macos/test-support/SparkleIntegrationDriver.swift'),'-o',str(WORK/'CodexHub'),'-F',str(DIST),'-framework','Sparkle','-framework','Cocoa','-framework','WebKit','-Xlinker','-rpath','-Xlinker','@executable_path/../Frameworks'])

results=[]
processes=[]
try:
    for case in ['wrong-signature','blocked-then-retry','success','slow-exit']:
        base=WORK/case; base.mkdir(); app=base/'Test.app'
        bid='local.codex-hub.updater-integration.'+uuid.uuid4().hex
        serve=SERVER/case; serve.mkdir()
        feed=f'http://127.0.0.1:{port}/{case}/appcast.xml'
        def makeapp(dst, version):
            (dst/'Contents/MacOS').mkdir(parents=True)
            (dst/'Contents/Resources').mkdir()
            (dst/'Contents/Frameworks').mkdir()
            shutil.copy2(WORK/'CodexHub',dst/'Contents/MacOS/CodexHub')
            shutil.copytree(DIST/'Sparkle.framework',dst/'Contents/Frameworks/Sparkle.framework',symlinks=True)
            delay = 'sleep 18; ' if case == 'slow-exit' and version == 1 else ''
            stub='''#!/bin/sh
trap 'if [ -e "'''+str(base/'allow-exit')+'''" ]; then '''+delay+'''exit 0; else printf "STOP_BLOCKED\\n"; fi' TERM
printf 'PANEL_URL=http://127.0.0.1:1\\n'
while :; do sleep 0.2; done
'''
            (dst/'Contents/Resources/node').write_text(stub); (dst/'Contents/Resources/node').chmod(0o755)
            info={'CFBundleIdentifier':bid,'CFBundleName':'Isolated Sparkle Test','CFBundleVersion':str(version),'CFBundleShortVersionString':'0.0.'+str(version),'CFBundleExecutable':'CodexHub','CFBundlePackageType':'APPL','LSMinimumSystemVersion':'12.0','LSUIElement':True,'SUFeedURL':feed,'SUPublicEDKey':public,'SUEnableAutomaticChecks':False,'SUAutomaticallyUpdate':False,'SUAllowsAutomaticUpdates':False,'SUVerifyUpdateBeforeExtraction':True,'SURequireSignedFeed':True,'SUSignedFeedFailureExpirationInterval':0,'NSAppTransportSecurity':{'NSAllowsArbitraryLoads':True}}
            with (dst/'Contents/Info.plist').open('wb') as f: plistlib.dump(info,f)
            run(['codesign','--force','--sign','-','--timestamp=none',str(dst)])
            run(['codesign','--verify','--deep','--strict',str(dst)])
        makeapp(app,1)
        new=base/'update/Test.app'; makeapp(new,2)
        archive=serve/'update.zip'
        run(['ditto','-c','-k','--sequesterRsrc','--keepParent',str(new),str(archive)])
        signing_seed=seed
        if case=='wrong-signature':
            signing_seed=base64.b64encode(Ed25519PrivateKey.generate().private_bytes(Encoding.Raw,PrivateFormat.Raw,NoEncryption()))
        signature=sign(archive,signing_seed)
        appcast=serve/'appcast.xml'
        appcast.write_text(f'''<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Isolated Test</title><item><title>2</title><sparkle:version>2</sparkle:version><sparkle:shortVersionString>0.0.2</sparkle:shortVersionString><sparkle:minimumSystemVersion>12.0</sparkle:minimumSystemVersion><enclosure url="http://127.0.0.1:{port}/{case}/update.zip" sparkle:edSignature="{signature}" length="{archive.stat().st_size}" type="application/octet-stream"/></item></channel></rss>''')
        sign(appcast)
        if case in ('success','slow-exit'): (base/'allow-exit').touch()
        log=(base/'process.log').open('w')
        proc=subprocess.Popen([str(app/'Contents/MacOS/CodexHub')],stdout=log,stderr=log)
        processes.append((proc,base,bid))
        if case=='wrong-signature':
            waitfor(lambda:'error:' in events(base))
            assert plistlib.load((app/'Contents/Info.plist').open('rb'))['CFBundleVersion']=='1'
            assert 'ready' not in events(base),events(base)
            assert proc.poll() is None
            results.append({'case':case,'result':'PASS','events':events(base)})
            (base/'allow-exit').touch(); (base/'finish-test').touch()
            waitfor(lambda:proc.poll() is not None,10)
        else:
            if case=='slow-exit':
                waitfor(lambda:'installing:false' in events(base))
                started=time.monotonic()
                waitfor(lambda:'wait-alert-shown' in events(base),22)
                assert time.monotonic()-started >= 14, 'The real 15-second wait notification did not elapse'
                assert proc.poll() is None, 'Application exited before slow runtime completed'
                assert plistlib.load((app/'Contents/Info.plist').open('rb'))['CFBundleVersion']=='1'
                assert 'quit-blocked' not in events(base), 'Waiting was misreported as cancelled termination'
                assert 'unexpected-runtime-exit' not in events(base)
                results.append({'case':'slow-exit-still-waiting','result':'PASS','events':events(base)})
            if case=='blocked-then-retry':
                waitfor(lambda:'quit-blocked' in events(base))
                time.sleep(2)
                assert proc.poll() is None
                assert plistlib.load((app/'Contents/Info.plist').open('rb'))['CFBundleVersion']=='1'
                assert 'launched-version-2' not in events(base)
                results.append({'case':'blocked-before-retry','result':'PASS','events':events(base)})
                (base/'allow-exit').touch(); (base/'retry').touch()
            waitfor(lambda:'launched-version-2' in events(base))
            assert plistlib.load((app/'Contents/Info.plist').open('rb'))['CFBundleVersion']=='2'
            if case=='slow-exit':
                observed=events(base)
                assert 'wait-alert-dismissed' in observed, 'Waiting sheet was not dismissed on runtime exit'
                assert observed.index('wait-alert-shown') < observed.index('wait-alert-dismissed') < observed.index('runtime-exited-approved') < observed.index('launched-version-2')
                assert 'quit-blocked' not in observed and 'unexpected-runtime-exit' not in observed
            results.append({'case':case,'result':'PASS','events':events(base)})
            (base/'allow-exit').touch(); (base/'finish-test').touch()
            time.sleep(.7)
        print(json.dumps(results[-1]),flush=True)
    (WORK/'results.json').write_text(json.dumps(results,indent=2))
    print('ARTIFACTS='+str(WORK),flush=True)
except Exception as error:
    print('FAILED='+repr(error),flush=True)
    print('ARTIFACTS='+str(WORK),flush=True)
    raise
finally:
    httpd.shutdown()
    for proc,base,bid in processes:
        (base/'allow-exit').touch(); (base/'finish-test').touch()
        try: proc.wait(timeout=6)
        except subprocess.TimeoutExpired:
            print('TEST_PROCESS_REQUIRES_CLEANUP='+str(proc.pid),flush=True)
    time.sleep(1)
    remaining=subprocess.run(['ps','-axo','pid=,command='],capture_output=True,text=True).stdout
    assert not any(str(WORK) in row and '/Contents/MacOS/CodexHub' in row for row in remaining.splitlines()), 'Test app still running; retain evidence for manual cleanup'
    for proc,base,bid in processes:
        assert bid.startswith('local.codex-hub.updater-integration.')
        cache=pathlib.Path.home()/'Library/Caches'/bid
        if cache.exists(): shutil.rmtree(cache)
        subprocess.run(['defaults','delete',bid],capture_output=True)
    print('CLEANUP=unique test apps stopped; preferences and caches removed',flush=True)
