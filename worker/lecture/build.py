"""Write one lecture reel's HyperFrames page: python3 build.py <spec.json> <dir>
The look Taha approved for the Hifdh lecture reels (11 Nov 2026), ported from the reels' own build.py: night paper (plate.png)
under a faded lapis lattice of 8-point stars, the hook in Caslon, his picture full width at 3:2 with fine moving film grain,
his name as a plain credit, and his subtitles (original language over English) under it. No takeaway, no outro: the reel ends
when he stops. No eyebrow, glow, text shadows or blur-ins.
spec: {"hook", "speaker", "fps", "vend" (seconds of voice), "lead" (seconds before it), "still" (bool),
       "caps": [[seconds from the voice's start, English, original or ""], ...]}. *words* in the English light lapis.
<dir> already holds voice.mp3 and face.mp4 (or face.png for a still); this adds index.html, fonts and the plate."""
import html, json, math, os, re, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
S = json.load(open(sys.argv[1])); out = sys.argv[2]
for f in ['plate.png', 'grain.png']: shutil.copy(os.path.join(HERE, f), os.path.join(out, f))
shutil.copytree(os.path.join(HERE, 'fonts'), os.path.join(out, 'fonts'), dirs_exist_ok=True)
shutil.copy(os.path.join(HERE, 'hyperframes.json'), out)

LEAD, vend, still, fps = S.get('lead', 0.4), S['vend'], S['still'], S['fps']
end = round(LEAD + vend + (0.6 if still else 0), 2)   # a still holds a beat; his video can't (the next frame is his next word)
caps = []
for k, (s, txt, orig) in enumerate(S['caps']):
    t0 = LEAD + s
    t1 = LEAD + S['caps'][k + 1][0] if k + 1 < len(S['caps']) else end
    caps.append((round(t0, 2), round(max(t1 - t0, 0.5), 2), txt, orig))

esc = lambda s: html.escape(s).replace('ﷺ', '<span class="hon">ﷺ</span>').replace('﵇', '<span class="hon">﵇</span>')
emph = lambda s: re.sub(r'\*(.+?)\*', r'<em>\1</em>', esc(s))
# a long phrase (the shortlist's lines run longer than the first four reels') sets smaller, so it stays clear of his name
capd = '\n'.join(f'  <div id="cap{i}" class="cap clip{" key" if "*" in x else ""}{" long" if len(x) + len(o) > 100 else ""}" data-start="{s}" data-duration="{d}" data-track-index="3">'
                 + (f'<span class="ar" lang="ar" dir="rtl">{esc(o)}</span>' if o else '') + f'<span class="en">{emph(x)}</span></div>'
                 for i, (s, d, x, o) in enumerate(caps))
facel = (f'<video src="face.mp4" muted playsinline data-start="{LEAD}" data-duration="{vend:.2f}" data-track-index="4"></video>'
         if not still else '<div class="pic"><img src="face.png" alt=""></div>')
hook = S['hook']
hsize = 72 if len(hook) <= 40 else 60
T = 180; SO = T / 2; SI = SO * math.cos(math.pi / 4) / math.cos(math.pi / 8)
def star(cx, cy):
    return 'M' + ' L'.join(f'{cx + (SO if k % 2 == 0 else SI) * math.cos(k * math.pi / 8 - math.pi / 2):.1f},{cy + (SO if k % 2 == 0 else SI) * math.sin(k * math.pi / 8 - math.pi / 2):.1f}' for k in range(16)) + 'Z'
LATTICE = ('<svg id="lattice" width="1080" height="1920" viewBox="0 0 1080 1920" aria-hidden="true"><path fill="none" stroke="#93b1ea" stroke-opacity=".2" stroke-width="1.6" stroke-linejoin="miter" d="'
           + ''.join(star(540 + i * T, 60 + j * T) for i in range(-4, 5) for j in range(-1, 12)) + '"/></svg>')
LMASK = 'linear-gradient(180deg, rgba(0,0,0,.6) 0%, rgba(0,0,0,0) 30%, rgba(0,0,0,0) 50%, #000 100%)'
page = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=1080, height=1920" />
<title>{esc(hook)}</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
@font-face {{ font-family: "Caslon"; src: url(fonts/libre-caslon-text-latin-400-normal.woff2) format("woff2"); font-weight: 400; font-style: normal }}
@font-face {{ font-family: "Geist"; src: url(fonts/geist-latin-wght-normal.woff2) format("woff2"); font-weight: 100 900 }}
@font-face {{ font-family: "Naskh"; src: url(fonts/noto_naskh_arabic_semibold.ttf) }}
@font-face {{ font-family: "Hon"; src: url(fonts/hon-scheherazadenew.woff2) format("woff2") }}
body {{ margin: 0; background: #15233f }}
#root {{ position: relative; width: 100%; height: 100%; overflow: hidden; background: #15233f; font-family: "Geist", sans-serif }}
#plate {{ position: absolute; inset: 0; width: 1080px; height: 1920px }}
#lattice {{ position: absolute; inset: 0; -webkit-mask-image: {LMASK}; mask-image: {LMASK} }}
#hook {{ position: absolute; left: 140px; width: 800px; top: 236px; margin: 0; text-align: center; text-wrap: balance;
  font: 400 {hsize}px/1.1 "Caslon", serif; color: #f3f4f1; letter-spacing: -.01em }}
#stage {{ position: absolute; left: 0; top: 446px; width: 1080px; transform-origin: 50% 30% }}
#face {{ position: relative; width: 1080px; overflow: hidden; isolation: isolate }}
#face video, #face .pic img {{ display: block; width: 1080px; height: auto; transform-origin: 50% 35% }}
#face .pic {{ transform-origin: 50% 35% }}
#face > .grain {{ position: absolute; inset: 0; overflow: hidden; mix-blend-mode: overlay }}
.grain img {{ position: absolute; left: -40px; top: -40px; width: 1160px; height: 800px }}
#who {{ position: absolute; left: 140px; width: 800px; top: 1186px; margin: 0; text-align: center; font: 500 28px/1.2 "Geist", sans-serif; color: rgba(243,244,241,.6) }}
.cap {{ position: absolute; left: 140px; width: 800px; top: 1246px; height: 254px; display: flex; flex-direction: column; gap: 14px;
  align-items: center; justify-content: flex-start; text-align: center; text-wrap: balance; color: #f3f4f1 }}
.cap .ar {{ font: 600 46px/1.45 "Naskh", serif; color: rgba(243,244,241,.82) }}
.cap .en {{ font: 500 52px/1.18 "Geist", sans-serif; letter-spacing: -.01em }}
.cap.long {{ gap: 10px }}
.cap.long .ar {{ font-size: 38px }}
.cap.long .en {{ font-size: 42px }}
.cap em {{ font-style: normal; color: #93b1ea }}
.hon {{ font-family: "Hon", serif; font-weight: 400; font-size: 1.05em; line-height: 0; vertical-align: -.08em }}
</style>
</head>
<body>
<div id="root" data-composition-id="lecture" data-start="0" data-width="1080" data-height="1920" data-fps="{fps}" data-duration="{end}">
  <audio id="voice" src="voice.mp3" data-start="{LEAD}" data-duration="{vend:.2f}" data-track-index="9"></audio>
  <img id="plate" src="plate.png" alt="">
  {LATTICE}
  <h1 id="hook">{esc(hook)}</h1>
  <div id="stage"><div id="face">{facel}<div class="grain"><img src="grain.png" alt=""></div></div></div>
  <p id="who">{esc(S['speaker'])}</p>
{capd}
</div>
<script>
const tl = gsap.timeline({{ paused: true }});
const OUT = "expo.out";
tl.fromTo("#hook", {{ opacity: 0, y: 20 }}, {{ opacity: 1, y: 0, duration: 0.9, ease: OUT }}, 0.05);
tl.fromTo("#stage", {{ opacity: 0, y: 24 }}, {{ opacity: 1, y: 0, duration: 0.9, ease: OUT }}, 0.25);
tl.fromTo("#who", {{ opacity: 0 }}, {{ opacity: 1, duration: 0.6, ease: OUT }}, 0.5);
if ({str(still).lower()}) {{
  tl.fromTo(".pic", {{ scale: 1 }}, {{ scale: 1.045, duration: {end}, ease: "none" }}, 0);
}}
let seed = 1447; const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;
for (let i = 0; i / {fps} < {end}; i++) tl.set(".grain img", {{ x: Math.round(rnd() * 76) - 38, y: Math.round(rnd() * 76) - 38 }}, Math.max(0, (i - 0.5) / {fps}));
document.querySelectorAll(".cap.clip").forEach(c => {{
  const s = +c.dataset.start, e = s + +c.dataset.duration;
  tl.fromTo(c, {{ opacity: 0, y: 10 }}, {{ opacity: 1, y: 0, duration: 0.3, ease: OUT }}, s);
  if (e < {end} - 0.5) tl.to(c, {{ opacity: 0, duration: 0.16, ease: "power1.in" }}, e - 0.16);
}});
window.__timelines["lecture"] = tl;
</script>
</body>
</html>
'''
open(os.path.join(out, 'index.html'), 'w').write(page)
print(f'{end}s, {len(caps)} captions')
