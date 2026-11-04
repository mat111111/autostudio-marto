"""Prueba de punta a punta en Chrome real: sube un video, edita con la UI, exporta con ffmpeg.wasm y verifica con ffprobe."""
import json, subprocess, sys, base64, os, time
from playwright.sync_api import sync_playwright

URL = os.environ.get("URL", "http://localhost:3111")
VIDEO = os.environ.get("VIDEO", "/tmp/asm/in.mp4")
OUT = "/tmp/asm/out.mp4"
OUT2 = "/tmp/asm/out2.mp4"
errors = []

def main():
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--no-sandbox"])
        page = b.new_page(viewport={"width": 1400, "height": 860})
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
        page.on("dialog", lambda d: d.dismiss())
        page.goto(URL)
        iso = page.evaluate("self.crossOriginIsolated")
        print("crossOriginIsolated:", iso)
        page.set_input_files("#videoIn", VIDEO)
        page.wait_for_selector("#drop.hidden", state="attached", timeout=20000)
        page.wait_for_timeout(1500)
        dur = page.evaluate("__app.store.state.source.duration")
        print("duración cargada:", dur)
        assert abs(dur - 14) < 0.2

        # --- Cortes manuales con teclado y botones
        page.evaluate("__app.seek(2)"); page.wait_for_timeout(300); page.keyboard.press("i")
        page.evaluate("__app.seek(3)"); page.wait_for_timeout(300); page.keyboard.press("o")
        page.click("#qCut")
        clips = page.evaluate("__app.store.state.clips.map(c=>[+c.start.toFixed(2),+c.end.toFixed(2)])")
        print("clips tras cortar 2-3:", clips)
        assert clips == [[0, 2], [3, 14]], clips
        # silencios sugeridos (ayuda visual)
        n_sil = page.evaluate("document.querySelectorAll('.sil').length")
        print("silencios sugeridos en la onda:", n_sil)
        assert n_sil >= 1
        # velocidad: marcar 8-10 y x2
        page.evaluate("__app.seek(8)"); page.wait_for_timeout(300); page.keyboard.press("i")
        page.evaluate("__app.seek(10)"); page.wait_for_timeout(300); page.keyboard.press("o")
        page.click("text=×2")
        sp = page.evaluate("__app.store.state.clips.map(c=>[+c.start.toFixed(1),+c.end.toFixed(1),c.speed])")
        print("clips con velocidad:", sp)
        assert [8, 10, 2] in sp

        # --- Subtítulo y título
        page.evaluate("__app.seek(4)"); page.wait_for_timeout(200)
        page.click("text=💬 Subtítulos"); page.click("text=＋ Subtítulo aquí")
        page.fill("#panel textarea >> nth=0", "Hola desde el editor manual")
        page.click("text=🔤 Textos"); page.click("text=＋ Título")
        # --- Zoom
        page.evaluate("__app.seek(5)"); page.wait_for_timeout(200)
        page.click("text=🔍 Encuadre"); page.click("text=＋ Zoom en la selección")
        # --- Tarjeta
        page.click("text=🎓 Tarjetas")
        page.select_option("#panel select >> nth=0", "definition")
        page.fill("#panel input >> nth=0", "Fotosíntesis")
        page.fill("#panel textarea >> nth=0", "Proceso por el cual las plantas convierten luz en energía química.")
        page.evaluate("__app.seek(6)"); page.wait_for_timeout(200)
        page.click("text=Agregar en la selección")
        st = page.evaluate("({subs:__app.store.state.subs.length,titles:__app.store.state.titles.length,zooms:__app.store.state.zooms.length,ov:__app.store.state.overlays.length})")
        print("elementos:", st)
        assert st == {"subs": 1, "titles": 1, "zooms": 1, "ov": 1}, st
        page.screenshot(path="/tmp/asm/ui.png")

        # undo / redo
        before = page.evaluate("__app.store.state.overlays.length")
        page.click("#btnUndo"); assert page.evaluate("__app.store.state.overlays.length") == before - 1
        page.click("#btnRedo"); assert page.evaluate("__app.store.state.overlays.length") == before

        # --- Exportar
        page.evaluate("__app.act(s=>{s.settings.res=540;s.settings.preset='ultrafast'})")
        page.click("#btnExport")
        page.click("text=🎬 Exportar MP4")
        t0 = time.time()
        page.wait_for_selector(".result video", timeout=420000)
        print("export terminado en %.1fs" % (time.time() - t0))
        info = page.evaluate("({size:__app.ui.result.blob.size,kind:__app.ui.result.kind,W:__app.ui.result.W,H:__app.ui.result.H,d:__app.ui.result.duration})")
        print("resultado:", info)
        b64 = page.evaluate("""async()=>{const b=__app.ui.result.blob;const buf=new Uint8Array(await b.arrayBuffer());let s='';for(let i=0;i<buf.length;i+=32768)s+=String.fromCharCode.apply(null,buf.subarray(i,i+32768));return btoa(s)}""")
        open(OUT, "wb").write(base64.b64decode(b64))
        # --- SRT descargado: los tiempos ya descuentan cortes y velocidad (sub original 8-10 s -> salida 7-8 s)
        page.click("text=💬 Subtítulos")
        with page.expect_download() as dl:
            page.click("text=Descargar .srt")
        srt = open(dl.value.path(), encoding="utf-8").read()
        print("SRT:", srt.strip().replace("\n", " | "))
        assert "00:00:07,000 --> 00:00:08,000" in srt

        # --- 2ª exportación: música + ducking + denoise + fondo desenfocado + 1:1, sin cortes
        page.set_input_files("#musicIn", "/tmp/asm/mus.wav")
        page.evaluate("""__app.act(s=>{s.clips=[{id:'c9',start:0,end:14,speed:1,volume:1}];s.zooms=[];s.subs=[];s.titles=[];s.overlays=[];
          s.settings.ratio='1:1';s.settings.fit='blur';s.settings.denoise=true;s.settings.res=540;s.settings.music.enabled=true;s.settings.music.volume=0.5;s.settings.music.duck=true;s.settings.music.loop=true;s.settings.normalize=true})""")
        t0 = time.time()
        page.evaluate("__app.runExport()")
        print("2ª export en %.1fs" % (time.time() - t0))
        info2 = page.evaluate("({W:__app.ui.result.W,H:__app.ui.result.H,d:__app.ui.result.duration})")
        b64 = page.evaluate("""async()=>{const b=__app.ui.result.blob;const buf=new Uint8Array(await b.arrayBuffer());let s='';for(let i=0;i<buf.length;i+=32768)s+=String.fromCharCode.apply(null,buf.subarray(i,i+32768));return btoa(s)}""")
        open(OUT2, "wb").write(base64.b64decode(b64))
        page.screenshot(path="/tmp/asm/ui2.png")
        b.close()
    pr = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", OUT]))
    print(json.dumps(pr))
    v = next(s for s in pr["streams"] if s["codec_type"] == "video")
    assert (v["width"], v["height"]) == (info["W"], info["H"]) == (540, 960)
    assert any(s["codec_type"] == "audio" for s in pr["streams"])
    # 0-2 (2) + 3-8 (5) + 8-10 a x2 (1) + 10-14 (4) = 12 s
    assert abs(float(pr["format"]["duration"]) - 12) < 0.4, pr["format"]["duration"]
    # Fase 2: 540x540, 14 s, y con música audible justo en un tramo donde el original está en silencio (2.6–3.9 s)
    p2 = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", OUT2]))
    v2 = next(s for s in p2["streams"] if s["codec_type"] == "video")
    assert (v2["width"], v2["height"]) == (540, 540), v2
    assert abs(float(p2["format"]["duration"]) - 14) < 0.4
    vd = subprocess.run(["ffmpeg", "-v", "info", "-ss", "2.6", "-t", "1.3", "-i", OUT2, "-af", "volumedetect", "-vn", "-f", "null", "-"], capture_output=True, text=True).stderr
    mean = float([l for l in vd.splitlines() if "mean_volume" in l][0].split(":")[1].split()[0])
    print("volumen medio en tramo mudo del original (con música): %.1f dB" % mean)
    assert mean > -50, "la música no se mezcló"
    bad = [e for e in errors if "favicon" not in e]
    print("errores de consola:", bad)
    assert not bad
    print("E2E OK")

main()
