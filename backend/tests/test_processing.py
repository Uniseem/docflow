from pathlib import Path

from PIL import Image

from app.services.processing import localize_images


def test_converts_images_to_webp_and_rewrites_links(tmp_path: Path) -> None:
    extracted = tmp_path / "extracted"
    images = extracted / "images"
    images.mkdir(parents=True)
    markdown_path = extracted / "full.md"
    markdown_path.write_text("# 文档\n\n![示例](images/chart.png)", encoding="utf-8")
    Image.new("RGBA", (32, 24), (210, 80, 40, 180)).save(images / "chart.png")
    permanent = tmp_path / "permanent"

    rewritten, count = localize_images(
        markdown_path.read_text(encoding="utf-8"),
        extracted_root=extracted,
        markdown_path=markdown_path,
        permanent_images=permanent,
        public_prefix="/media/doc/images",
        quality=88,
    )

    assert count == 1
    assert ".png" not in rewritten
    assert "/media/doc/images/chart-" in rewritten
    outputs = list(permanent.iterdir())
    assert len(outputs) == 1
    assert outputs[0].suffix == ".webp"
    assert not list(permanent.glob("*.png"))

