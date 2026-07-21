# -*- coding: utf-8 -*-
"""生成应用图标 assets/icon.png 与 assets/icon.ico"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).parent
ASSETS = ROOT / "assets"
ASSETS.mkdir(exist_ok=True)

SIZE = 256
RADIUS = 56
BG = (61, 107, 255, 255)      # #3d6bff
FG = (255, 255, 255, 255)

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=RADIUS, fill=BG)

# 找一个粗体字体
font = None
candidates = [
    Path(r"C:\Windows\Fonts\arialbd.ttf"),
    Path(r"C:\Windows\Fonts\segoeuib.ttf"),
]
try:
    import matplotlib
    candidates.append(Path(matplotlib.__file__).parent / "mpl-data" / "fonts" / "ttf" / "DejaVuSans-Bold.ttf")
except Exception:
    pass
for c in candidates:
    if c.exists():
        font = ImageFont.truetype(str(c), 150)
        break
if font is None:
    font = ImageFont.load_default()

text = "K"
bbox = d.textbbox((0, 0), text, font=font)
w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
d.text(((SIZE - w) / 2 - bbox[0], (SIZE - h) / 2 - bbox[1]), text, font=font, fill=FG)

img.save(ASSETS / "icon.png")
img.save(ASSETS / "icon.ico", sizes=[(256, 256), (64, 64), (48, 48), (32, 32), (16, 16)])

# 托盘图标（32x32）
img.resize((32, 32), Image.LANCZOS).save(ASSETS / "tray.png")
print("ok:", ASSETS / "icon.png", ASSETS / "icon.ico", ASSETS / "tray.png")
