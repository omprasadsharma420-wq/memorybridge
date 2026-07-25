from pathlib import Path
from PIL import Image, ImageDraw

SCALE = 4
SIZE = 256


def point(value: float) -> int:
    return round(value * SCALE)


image = Image.new("RGBA", (SIZE * SCALE, SIZE * SCALE), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle(
    (0, 0, point(SIZE), point(SIZE)),
    radius=point(54),
    fill="#0c0f0d",
)

ground = [
    (46, 185),
    (78, 168),
    (102, 169),
    (128, 184),
    (154, 169),
    (178, 168),
    (210, 185),
]
draw.line(
    [(point(x), point(y)) for x, y in ground],
    fill="#465439",
    width=point(9),
    joint="curve",
)

pillars = [
    (77, 169, 114, 56),
    (128, 165, 68, 74),
    (179, 160, 99, 64),
]
for center, bottom, top, radius in pillars:
    box = (
        point(center - radius / 4),
        point(top),
        point(center + radius / 4),
        point(top + radius / 2),
    )
    draw.arc(box, 180, 360, fill="#a9bd76", width=point(9))
    draw.line(
        (point(center - radius / 4), point(top + radius / 4), point(center - radius / 4), point(bottom)),
        fill="#a9bd76",
        width=point(9),
    )
    draw.line(
        (point(center + radius / 4), point(top + radius / 4), point(center + radius / 4), point(bottom - 10)),
        fill="#8da65e",
        width=point(9),
    )

image = image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
output = Path(__file__).resolve().parents[1] / "build" / "icon.ico"
output.parent.mkdir(parents=True, exist_ok=True)
image.save(output, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(output)
