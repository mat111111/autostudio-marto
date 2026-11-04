"""Humo de UI: importar SRT, imagen, selector de foco, publicar, versiones, guardar/abrir proyecto, atajos."""
import os, json
from playwright.sync_api import sync_playwright

URL = os.environ.get("URL", "http://localhost:3111")
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--no-sandbox"])
    page = b.new_page(viewport={"width": 1400, "height": 860}, accept_downloads=True)
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR " + str(e)))
    page.on("dialog", lambda d: d.dismiss())
    page.goto(URL)
    page.set_input_files("#videoIn", "/tmp/asm/in.mp4")
    page.wait_for_selector("#drop.hidden", state="attached", timeout=20000)
    page.wait_for_timeout(1200)
    ev = lambda js: page.evaluate(js)

    # SRT
    page.click("text=💬 Subtítulos"); page.set_input_files("#srtIn", "/tmp/asm/t.srt")
    page.wait_for_timeout(300)
    assert ev("__app.store.state.subs.map(s=>s.text)") == ["Primera línea", "Segunda línea"]
    # editar texto de un subtítulo y su tiempo
    page.fill("#panel textarea >> nth=0", "Editado a mano")
    page.fill("#panel .tm >> nth=1", "0:03.5"); page.press("#panel .tm >> nth=1", "Enter"); page.dispatch_event("#panel .tm >> nth=1", "change")
    s0 = ev("__app.store.state.subs[0]")
    assert s0["text"] == "Editado a mano" and abs(s0["end"] - 3.5) < 1e-6, s0
    # imagen
    page.click("text=🔤 Textos"); page.set_input_files("#imgIn", "/tmp/asm/logo.png"); page.wait_for_timeout(400)
    assert ev("__app.store.state.overlays.filter(o=>o.kind==='image').length") == 1
    assert ev("__app.ui.images.size") == 1
    # selector de foco global
    page.click("text=🔍 Encuadre")
    box = page.locator("#panel canvas.picker").first.bounding_box()
    page.mouse.move(box["x"] + box["width"] * 0.8, box["y"] + box["height"] * 0.3); page.mouse.down(); page.mouse.up()
    cx = ev("__app.store.state.settings.cx")
    assert cx > 0.7, cx
    # zoom + foco del zoom
    page.evaluate("__app.seek(6)"); page.wait_for_timeout(200)
    page.click("text=＋ Zoom en la selección"); page.wait_for_timeout(300)
    box = page.locator("#panel canvas.picker").nth(1).bounding_box()
    page.mouse.move(box["x"] + box["width"] * 0.2, box["y"] + box["height"] * 0.5); page.mouse.down(); page.mouse.up()
    z = ev("__app.store.state.zooms[0]")
    assert z["cx"] < 0.35, z
    # arrastrar el subtítulo seleccionado en la vista previa cambia su posición vertical
    ev("__app.select('sub', __app.store.state.subs[0].id)")
    cb = page.locator("#stage").bounding_box()
    page.mouse.move(cb["x"] + cb["width"] / 2, cb["y"] + cb["height"] * 0.5); page.mouse.down(); page.mouse.move(cb["x"] + cb["width"] / 2, cb["y"] + cb["height"] * 0.5 + 1); page.mouse.up()
    assert abs(ev("__app.store.state.subStyle.y") - 0.5) < 0.05
    # atajos: cortar, deshacer con Ctrl+Z, rehacer
    page.evaluate("__app.seek(10)"); page.keyboard.press("s")
    assert len(ev("__app.store.state.clips")) == 2
    page.keyboard.press("Control+z"); assert len(ev("__app.store.state.clips")) == 1
    page.keyboard.press("Control+y"); assert len(ev("__app.store.state.clips")) == 2
    # publicar: plantillas
    page.click("text=📣 Publicar")
    page.fill("#panel input >> nth=1", "la fotosíntesis")
    page.fill("#panel input >> nth=5", "biología, ciencia")
    txt = page.inner_text("#panel .out")
    assert "#biologia" in txt and "la fotosíntesis" in txt
    # historial: guardar versión, modificar, restaurar
    page.click("text=🕘 Historial"); page.fill("#panel input >> nth=0", "v1"); page.click("text=Guardar versión actual")
    page.evaluate("__app.act(s=>{s.titles.push({id:'t_q',start:0,end:1,text:'x',x:.5,y:.5,size:50,color:'#fff',bg:'',font:'Impact',weight:800})})")
    assert len(ev("__app.store.state.titles")) == 1
    page.click("text=Restaurar >> nth=0"); page.wait_for_timeout(200)
    assert len(ev("__app.store.state.titles")) == 0
    # proyecto: guardar y abrir
    page.click("text=🕘 Historial")
    with page.expect_download() as dl:
        page.click("text=Guardar proyecto (.json)")
    path = dl.value.path()
    proj = json.load(open(path))
    assert proj["app"] == "autostudio-manual" and len(proj["state"]["subs"]) == 2
    page.evaluate("__app.act(s=>{s.subs=[]})"); assert ev("__app.store.state.subs.length") == 0
    page.set_input_files("#projIn", path); page.wait_for_timeout(500)
    assert ev("__app.store.state.subs.length") == 2
    # reproducción real: avanza y se salta el hueco cortado
    ev("__app.act(s=>{s.clips=[{id:'a',start:0,end:1,speed:1,volume:1},{id:'b',start:3,end:5,speed:1,volume:1}]})")
    page.evaluate("__app.seek(0.2)"); page.click("#btnPlay"); page.wait_for_timeout(1700)
    t = ev("__app.ui.video.currentTime")
    print("reproduciendo, t =", round(t, 2))
    assert t > 3.0, "no saltó el hueco"
    page.screenshot(path="/tmp/asm/ui3.png")
    b.close()
bad = [e for e in errors if "favicon" not in e]
print("errores de consola:", bad)
assert not bad
print("UI OK")
