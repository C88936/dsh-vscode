"""Generate, edit and reopen Office files using only the bundled interpreter."""
import sys
import tempfile
from pathlib import Path
from docx import Document
from openpyxl import Workbook, load_workbook
from pptx import Presentation
from pptx.util import Inches


def check(root):
    """Check saved edits in all three authoring libraries."""
    root.mkdir(parents=True, exist_ok=True)
    document = Document()
    document.add_paragraph("Before edit")
    document.save(root / "document.docx")
    document = Document(root / "document.docx")
    document.paragraphs[0].text = "Office authoring acceptance: saved edit"
    document.save(root / "document.docx")
    assert Document(root / "document.docx").paragraphs[0].text.endswith("saved edit")

    workbook = Workbook()
    workbook.active["A1"] = 1
    workbook.save(root / "workbook.xlsx")
    workbook.close()
    workbook = load_workbook(root / "workbook.xlsx")
    workbook.active["A1"] = 42
    workbook.save(root / "workbook.xlsx")
    workbook.close()
    workbook = load_workbook(root / "workbook.xlsx")
    assert workbook.active["A1"].value == 42
    workbook.close()

    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    slide.shapes.add_textbox(Inches(1), Inches(1), Inches(5), Inches(1)).text = "Before edit"
    presentation.save(root / "presentation.pptx")
    presentation = Presentation(root / "presentation.pptx")
    presentation.slides[0].shapes[0].text = "Saved edit"
    presentation.save(root / "presentation.pptx")
    assert Presentation(root / "presentation.pptx").slides[0].shapes[0].text == "Saved edit"
    print("DOCX/XLSX/PPTX generation, editing and reopen passed.")


if len(sys.argv) == 2:
    check(Path(sys.argv[1]))
else:
    with tempfile.TemporaryDirectory(prefix="dsh-office-acceptance-") as directory:
        check(Path(directory))
