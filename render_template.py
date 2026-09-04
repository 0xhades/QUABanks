#!/usr/bin/env python3
"""Render a versioned Tutor question packet into the isolated Week 1 PDF template."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from dataclasses import dataclass
from html import escape
from pathlib import Path
from typing import Any

from pypdf import PdfReader
from reportlab.lib.colors import Color, HexColor, black, white
import arabic_reshaper
from bidi.algorithm import get_display
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import Paragraph


ROOT = Path(os.environ.get("AOUNMED_RENDER_ROOT", Path(__file__).resolve().parent)).resolve()
OUTPUT_ROOT = ROOT / "output"
PDF_ROOT = OUTPUT_ROOT / "pdf"

PAGE_WIDTH, PAGE_HEIGHT = A4
BACKGROUND = HexColor("#99BFD4")
SLATE = HexColor("#507283")
NAVY = HexColor("#00004D")
MUTED_BLUE = HexColor("#C7DFEA")
ANSWER_BLUE = HexColor("#557A8A")
SHADOW = HexColor("#A7BBC5")
NOTE_AMBER = HexColor("#9A5B16")
NOTE_BG = HexColor("#FFF1D6")

PANEL_X = 16
PANEL_Y = 25
PANEL_W = PAGE_WIDTH - 32
PANEL_H = PAGE_HEIGHT - 45
BODY_TOP = PAGE_HEIGHT - 105
BODY_BOTTOM = 74
BODY_LEFT = 36
BODY_RIGHT = PAGE_WIDTH - 36
COLUMN_GAP = 18
COLUMN_WIDTH = (BODY_RIGHT - BODY_LEFT - COLUMN_GAP) / 2

FONT_ROOT = ROOT / "assets" / "fonts"
FONT_PATHS = {
    "WeekCover": FONT_ROOT / "Fredoka-Bold.ttf",
    "WeekTitle": FONT_ROOT / "Fredoka-SemiBold.ttf",
    "WeekBody": FONT_ROOT / "WorkSans-Regular.ttf",
    "WeekBodyBold": FONT_ROOT / "WorkSans-SemiBold.ttf",
    "WeekBodyHeavy": FONT_ROOT / "WorkSans-Bold.ttf",
    "WeekBodyItalic": FONT_ROOT / "WorkSans-Italic.ttf",
    "WeekArabic": FONT_ROOT / "NotoSansArabic-Bold.ttf",
}


@dataclass
class PositionedItem:
    page: int
    section_id: str
    item_id: str
    column: int
    x: float
    y: float
    width: float
    height: float


def register_fonts() -> None:
    for name, path in FONT_PATHS.items():
        if not path.exists():
            raise FileNotFoundError(f"required template font is missing: {path}")
        pdfmetrics.registerFont(TTFont(name, str(path)))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_packet(packet: dict[str, Any]) -> dict[str, Any]:
    if packet.get("schema_version") != "pdf-template-v1":
        raise ValueError("schema_version must be pdf-template-v1")
    document = packet.get("document")
    if not isinstance(document, dict):
        raise ValueError("document must be an object")
    if not str(document.get("title", "")).strip() or not str(document.get("week", "")).strip():
        raise ValueError("document title and week are required")
    lecture_sections = _lecture_sections(document)
    if not lecture_sections:
        raise ValueError("document.lectures must contain at least one lecture section")

    lecture_ids: set[str] = set()
    validated_lecture_objects: set[int] = set()
    section_ids: set[str] = set()
    question_ids: set[str] = set()
    for lecture, section in lecture_sections:
        lecture_id = str(lecture.get("id", "")).strip()
        lecture_title = str(lecture.get("title", "")).strip()
        if id(lecture) not in validated_lecture_objects:
            if not lecture_id or lecture_id in lecture_ids:
                raise ValueError(f"lecture id is missing or duplicated: {lecture_id!r}")
            lecture_ids.add(lecture_id)
            if not lecture_title:
                raise ValueError(f"lecture {lecture_id} has no title")
            validated_lecture_objects.add(id(lecture))
        section_id = str(section.get("id", "")).strip()
        title = str(section.get("title", "")).strip()
        layout = section.get("layout")
        questions = section.get("questions")
        if not section_id or section_id in section_ids:
            raise ValueError(f"section id is missing or duplicated: {section_id!r}")
        section_ids.add(section_id)
        if not title:
            raise ValueError(f"section {section_id} has no title")
        if layout not in {"mcq_two_column", "seq_single_column", "explain_why"}:
            raise ValueError(f"section {section_id} has unsupported layout {layout!r}")
        if not isinstance(questions, list) or not questions:
            raise ValueError(f"section {section_id} has no questions")

        numbers: set[int] = set()
        for question in questions:
            question_id = str(question.get("id", "")).strip()
            number = question.get("number")
            kind = question.get("type")
            stem = str(question.get("stem", "")).strip()
            if not question_id or question_id in question_ids:
                raise ValueError(f"question id is missing or duplicated: {question_id!r}")
            question_ids.add(question_id)
            if not isinstance(number, int) or number < 1 or number in numbers:
                raise ValueError(f"section {section_id} has an invalid/duplicate number {number!r}")
            numbers.add(number)
            if kind not in {"mcq", "multi_select", "seq", "ospe", "other", "explain_why"} or not stem:
                raise ValueError(f"question {question_id} has invalid type or empty stem")
            if layout == "mcq_two_column" and kind not in {"mcq", "multi_select"}:
                raise ValueError(f"question {question_id} must be mcq/multi_select in an MCQ section")
            if layout == "seq_single_column" and kind not in {"seq", "ospe", "other"}:
                raise ValueError(f"question {question_id} must be seq/ospe/other in an SEQ section")
            if layout == "explain_why" and kind != "explain_why":
                raise ValueError(f"question {question_id} must be explain_why")
            if kind in {"mcq", "multi_select"}:
                options = question.get("options")
                if not isinstance(options, list) or not 2 <= len(options) <= 6:
                    raise ValueError(f"MCQ {question_id} needs 2-6 options")
                labels = [str(option.get("label", "")).strip() for option in options]
                if len(labels) != len(set(labels)) or any(not label for label in labels):
                    raise ValueError(f"MCQ {question_id} has invalid option labels")
                answers = question.get("correct_answers")
                if answers is None:
                    answers = [str(question.get("answer", "")).strip()]
                if not isinstance(answers, list) or not answers or any(answer not in labels for answer in answers):
                    raise ValueError(f"choice question {question_id} answers do not match its options")
                if kind == "mcq" and len(answers) != 1:
                    raise ValueError(f"MCQ {question_id} must have exactly one correct answer")
            for media in _question_media(question):
                media_path = (ROOT / str(media["path"])).resolve()
                if ROOT not in media_path.parents or not media_path.is_file():
                    raise ValueError(f"question {question_id} media is missing or unsafe")
            _validate_question_metadata(question_id, question)
        hints = section.get("hints", [])
        if not isinstance(hints, list):
            raise ValueError(f"section {section_id} hints must be a list")
        for hint in hints:
            if not isinstance(hint, dict) or not str(hint.get("id", "")).strip() or not str(hint.get("text", "")).strip():
                raise ValueError(f"section {section_id} has an invalid hint")
    closing_page = document.get("closing_page")
    if closing_page is not None:
        if not isinstance(closing_page, dict):
            raise ValueError("document.closing_page must be an object")
        paragraphs = closing_page.get("paragraphs")
        if not isinstance(paragraphs, list) or not paragraphs or any(
            not str(paragraph).strip() for paragraph in paragraphs
        ):
            raise ValueError("document.closing_page.paragraphs must contain non-empty text")
        if not str(closing_page.get("signoff", "")).strip():
            raise ValueError("document.closing_page.signoff is required")
    return document


def _lecture_sections(document: dict[str, Any]) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    """Return lecture/section pairs, accepting the pre-v1 flat import shape.

    The public packet contract is ``document.lectures[].sections[]``.  Older drafts used
    ``document.sections[]`` and carried a redundant ``section.lecture`` object.  Keeping this
    small compatibility adapter at the renderer boundary lets an old draft still be rendered,
    while every new sample and editor save uses the nested representation.
    """
    lectures = document.get("lectures")
    if lectures is not None:
        if not isinstance(lectures, list):
            raise ValueError("document.lectures must be a list")
        pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for lecture in lectures:
            if not isinstance(lecture, dict):
                raise ValueError("each document.lectures item must be an object")
            nested = lecture.get("sections")
            if not isinstance(nested, list) or not nested:
                raise ValueError(f"lecture {lecture.get('id', '')!r} must have sections")
            for section in nested:
                if not isinstance(section, dict):
                    raise ValueError("each lecture section must be an object")
                pairs.append((lecture, section))
        return pairs

    legacy = document.get("sections")
    if not isinstance(legacy, list):
        raise ValueError("document.lectures must be a list")
    grouped: dict[str, dict[str, Any]] = {}
    pairs = []
    for section in legacy:
        if not isinstance(section, dict):
            raise ValueError("each legacy document.sections item must be an object")
        source_lecture = section.get("lecture")
        if not isinstance(source_lecture, dict):
            source_lecture = {"id": section.get("id", ""), "title": section.get("title", "")}
        lecture_id = str(source_lecture.get("id", "")).strip()
        lecture = grouped.get(lecture_id)
        if lecture is None:
            lecture = {
                "id": source_lecture.get("id", ""),
                "title": source_lecture.get("title", section.get("title", "")),
                "sections": [],
            }
            grouped[lecture_id] = lecture
        clean_section = dict(section)
        clean_section.pop("lecture", None)
        lecture["sections"].append(clean_section)
        pairs.append((lecture, clean_section))
    return pairs


def _question_media(question: dict[str, Any]) -> list[dict[str, str]]:
    """Normalize legacy image/caption and the structured media array."""
    if question.get("media") is not None:
        media = question["media"]
        if not isinstance(media, list):
            raise ValueError(f"question {question.get('id')} media must be a list")
        normalized: list[dict[str, str]] = []
        for item in media:
            if not isinstance(item, dict) or not str(item.get("path", "")).strip():
                raise ValueError(f"question {question.get('id')} has invalid media")
            normalized.append({
                "path": str(item["path"]),
                "alt_text": str(item.get("alt_text", "")),
                "caption": str(item.get("caption", "")),
            })
        return normalized
    if question.get("image"):
        return [{
            "path": str(question["image"]),
            "alt_text": "",
            "caption": str(question.get("caption", "")),
        }]
    return []


def _validate_question_metadata(question_id: str, question: dict[str, Any]) -> None:
    refs = question.get("lecture_refs", [])
    if not isinstance(refs, list):
        raise ValueError(f"question {question_id} lecture_refs must be a list")
    for ref in refs:
        slides = ref.get("slide_numbers") if isinstance(ref, dict) else None
        if not isinstance(ref, dict) or not str(ref.get("lecture_title", "")).strip():
            raise ValueError(f"question {question_id} has an invalid lecture reference")
        if not isinstance(slides, list) or not slides or any(not isinstance(n, int) or n < 1 for n in slides):
            raise ValueError(f"question {question_id} has invalid lecture slide numbers")
    bank = question.get("bank_source")
    if bank is not None:
        if not isinstance(bank, dict) or not str(bank.get("name", "")).strip():
            raise ValueError(f"question {question_id} has an invalid bank source")
        pages = bank.get("page_numbers", [])
        if not isinstance(pages, list) or any(not isinstance(n, int) or n < 1 for n in pages):
            raise ValueError(f"question {question_id} has invalid bank page numbers")
    notes = question.get("notes", [])
    if not isinstance(notes, list) or any(
        not isinstance(note, dict)
        or note.get("kind") not in {"note", "warning", "instruction", "source_limit"}
        or not str(note.get("text", "")).strip()
        for note in notes
    ):
        raise ValueError(f"question {question_id} has invalid notes")


def styles() -> dict[str, ParagraphStyle]:
    return {
        "stem": ParagraphStyle(
            "stem",
            fontName="WeekBodyBold",
            fontSize=9.4,
            leading=11.5,
            textColor=black,
            spaceAfter=3,
        ),
        "case": ParagraphStyle(
            "case",
            fontName="WeekBodyItalic",
            fontSize=8.7,
            leading=10.8,
            textColor=HexColor("#263238"),
            leftIndent=4,
            borderColor=MUTED_BLUE,
            borderWidth=0,
            borderPadding=(4, 5, 4, 5),
            backColor=HexColor("#EDF5F8"),
            spaceAfter=5,
        ),
        "option": ParagraphStyle(
            "option",
            fontName="WeekBody",
            fontSize=9.2,
            leading=11.2,
            textColor=black,
            leftIndent=4,
        ),
        "source": ParagraphStyle(
            "source",
            fontName="WeekBodyItalic",
            fontSize=7.2,
            leading=8.5,
            textColor=ANSWER_BLUE,
            spaceBefore=2,
        ),
        "meta": ParagraphStyle(
            "meta",
            fontName="WeekBodyItalic",
            fontSize=7.2,
            leading=8.7,
            textColor=SLATE,
            spaceBefore=1,
        ),
        "note": ParagraphStyle(
            "note",
            fontName="WeekBodyItalic",
            fontSize=7.8,
            leading=9.6,
            textColor=HexColor("#4D5C62"),
            leftIndent=5,
            borderColor=MUTED_BLUE,
            borderWidth=0,
            borderPadding=(3, 5, 3, 5),
            backColor=HexColor("#EDF5F8"),
            spaceBefore=2,
        ),
        "warning": ParagraphStyle(
            "warning",
            fontName="WeekBodyBold",
            fontSize=7.4,
            leading=9.2,
            textColor=NOTE_AMBER,
            leftIndent=5,
            borderColor=NOTE_AMBER,
            borderWidth=0,
            borderPadding=(3, 5, 3, 5),
            backColor=NOTE_BG,
            spaceBefore=2,
        ),
        "explanation": ParagraphStyle(
            "explanation",
            fontName="WeekBody",
            fontSize=8.1,
            leading=10,
            textColor=HexColor("#263238"),
            leftIndent=8,
            spaceBefore=2,
        ),
        "seq": ParagraphStyle(
            "seq",
            fontName="WeekBodyBold",
            fontSize=10.2,
            leading=13.2,
            textColor=black,
            spaceAfter=4,
        ),
        "answer": ParagraphStyle(
            "answer",
            fontName="WeekBodyBold",
            fontSize=9.8,
            leading=12.5,
            textColor=ANSWER_BLUE,
            leftIndent=10,
            spaceBefore=4,
        ),
    }


class PacketRenderer:
    def __init__(self, output_path: Path, document: dict[str, Any]) -> None:
        self.output_path = output_path
        self.document = document
        self.canvas = Canvas(str(output_path), pagesize=A4, pageCompression=1)
        self.canvas.setTitle(f"{document['title']} - {document['week']}")
        self.canvas.setAuthor("AounMED PDF template experiment")
        self.canvas.setSubject("Deterministic Tutor question-packet preview")
        self.styles = styles()
        self.page_number = 0
        self.section: dict[str, Any] | None = None
        self.lecture: dict[str, Any] | None = None
        self.lecture_sections = _lecture_sections(document)
        self.sections = [section for _, section in self.lecture_sections]
        self.section_lectures = {
            str(section["id"]): lecture for lecture, section in self.lecture_sections
        }
        self.column = 0
        self.cursor_y = BODY_TOP
        self.page_answers: list[str] = []
        self.layout: list[PositionedItem] = []
        self.two_column = False
        self.page_open = False
        self.section_destinations = {
            str(section["id"]): f"section-{index:03d}"
            for index, section in enumerate(self.sections, 1)
        }
        self.bookmarked_sections: set[str] = set()
        self.contents_link_count = 0

    def draw_cover(self) -> None:
        self.page_number = 1
        c = self.canvas
        c.setFillColor(BACKGROUND)
        c.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
        c.setLineWidth(1.3)
        c.setStrokeColor(NAVY)
        c.setFillColor(SLATE)
        c.roundRect(16, PAGE_HEIGHT - 369, PAGE_WIDTH - 32, 350, 17, fill=1, stroke=1)
        c.roundRect(19, 26, PAGE_WIDTH - 38, 425, 17, fill=1, stroke=1)

        title = str(self.document["title"]).upper()
        week = str(self.document["week"]).upper()
        self._cover_text(title, PAGE_HEIGHT - 155, 52)
        self._cover_text(week, PAGE_HEIGHT - 270, 44)

        c.setFont("WeekCover", 24)
        c.setFillColor(SHADOW)
        c.drawString(41, 382, "TABLE OF CONTENT")
        c.setFillColor(white)
        c.drawString(37, 387, "TABLE OF CONTENT")

        y = 340
        previous_lecture_id: str | None = None
        for lecture, section in self.lecture_sections:
            lecture_id = str(lecture["id"])
            if lecture_id != previous_lecture_id:
                lecture_text = str(lecture["title"])
                if y < 62:
                    break
                c.setFont("WeekBodyBold", 9.5)
                c.setFillColor(white)
                c.drawString(29, y, lecture_text)
                width = min(pdfmetrics.stringWidth(lecture_text, "WeekBodyBold", 9.5), PAGE_WIDTH - 80)
                c.setLineWidth(0.8)
                c.line(29, y - 2, 29 + width, y - 2)
                c.linkAbsolute(
                    contents=f"Go to {lecture_text}",
                    destinationname=self.section_destinations[str(section["id"])],
                    Rect=(27, y - 5, min(PAGE_WIDTH - 27, 33 + width), y + 13),
                    thickness=0,
                )
                self.contents_link_count += 1
                y -= 22
                previous_lecture_id = lecture_id

            # A lecture may contain several independent layout sections.  Keep each
            # section reachable from the cover while avoiding a duplicate line when
            # the single section is already named exactly like its lecture.
            if len(lecture.get("sections", [])) > 1 or str(section["title"]) != str(lecture["title"]):
                section_text = f"↳ {section['title']}"
                if y < 62:
                    break
                c.setFont("WeekBody", 8.5)
                c.setFillColor(white)
                c.drawString(42, y, section_text)
                width = min(pdfmetrics.stringWidth(section_text, "WeekBody", 8.5), PAGE_WIDTH - 92)
                c.setLineWidth(0.55)
                c.line(42, y - 2, 42 + width, y - 2)
                c.linkAbsolute(
                    contents=f"Go to {section['title']}",
                    destinationname=self.section_destinations[str(section["id"])],
                    Rect=(40, y - 5, min(PAGE_WIDTH - 27, 46 + width), y + 12),
                    thickness=0,
                )
                self.contents_link_count += 1
                y -= 21

        self._draw_skin_icon(PAGE_WIDTH - 125, 320)
        c.showPage()

    def _cover_text(self, value: str, y: float, size: float) -> None:
        c = self.canvas
        width = pdfmetrics.stringWidth(value, "WeekCover", size)
        x = (PAGE_WIDTH - width) / 2
        c.setFont("WeekCover", size)
        c.setFillColor(SHADOW)
        c.drawString(x + 5, y - 6, value)
        c.setFillColor(white)
        c.drawString(x, y, value)

    def _draw_skin_icon(self, x: float, y: float) -> None:
        c = self.canvas
        c.setFillColor(HexColor("#F8B07A"))
        c.roundRect(x, y, 82, 57, 5, fill=1, stroke=0)
        c.setFillColor(HexColor("#F08072"))
        c.rect(x, y, 82, 18, fill=1, stroke=0)
        c.setStrokeColor(HexColor("#7D3D46"))
        c.setLineWidth(1)
        for offset in (15, 38, 62):
            c.line(x + offset, y + 57, x + offset - 4, y + 34)
            c.circle(x + offset - 4, y + 28, 4, fill=0, stroke=1)
        c.setFillColor(HexColor("#D45664"))
        c.circle(x + 65, y + 9, 4, fill=1, stroke=0)

    def begin_page(self, section: dict[str, Any]) -> None:
        self.section = section
        self.lecture = self.section_lectures.get(str(section["id"]))
        self.two_column = section["layout"] == "mcq_two_column"
        self.page_number += 1
        self.column = 0
        self.cursor_y = BODY_TOP
        self.page_answers = []
        self.page_open = True
        c = self.canvas
        section_id = str(section["id"])
        if section_id not in self.bookmarked_sections:
            destination = self.section_destinations[section_id]
            c.bookmarkPage(destination, fit="FitH", top=PAGE_HEIGHT)
            c.addOutlineEntry(str(section["title"]), destination, level=0, closed=False)
            self.bookmarked_sections.add(section_id)
        c.setFillColor(BACKGROUND)
        c.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
        c.setFillColor(white)
        c.setStrokeColor(NAVY)
        c.setLineWidth(1.25)
        c.roundRect(PANEL_X, PANEL_Y, PANEL_W, PANEL_H, 16, fill=1, stroke=1)
        c.setFillColor(SLATE)
        title = str(section["title"])
        lecture_title = str(self.lecture.get("title", "")) if self.lecture else ""
        if lecture_title and lecture_title != title:
            c.setFont("WeekTitle", 16)
            lecture_width = pdfmetrics.stringWidth(lecture_title, "WeekTitle", 16)
            c.drawString((PAGE_WIDTH - lecture_width) / 2, PAGE_HEIGHT - 62, lecture_title)
            c.setFont("WeekBodyBold", 9.5)
            section_width = pdfmetrics.stringWidth(title, "WeekBodyBold", 9.5)
            c.drawString((PAGE_WIDTH - section_width) / 2, PAGE_HEIGHT - 81, title)
        else:
            c.setFont("WeekTitle", 18)
            title_width = pdfmetrics.stringWidth(title, "WeekTitle", 18)
            c.drawString((PAGE_WIDTH - title_width) / 2, PAGE_HEIGHT - 66, title)
        if self.two_column:
            divider = PAGE_WIDTH / 2
            c.setStrokeColor(Color(0.1, 0.1, 0.1, alpha=0.8))
            c.setLineWidth(0.55)
            c.line(divider, BODY_BOTTOM + 22, divider, BODY_TOP + 3)
        else:
            kinds = {question["type"] for question in section["questions"]}
            if kinds == {"ospe"}:
                label = "OSPE"
            elif kinds == {"other"}:
                label = "Open questions"
            else:
                label = "SEQs" if section["layout"] == "seq_single_column" else "Explain why"
            self._draw_badge(label, BODY_LEFT, BODY_TOP - 4)
            self.cursor_y -= 43

    def _draw_badge(self, label: str, x: float, top: float) -> None:
        c = self.canvas
        size = 11.5
        width = pdfmetrics.stringWidth(label, "WeekBodyBold", size) + 14
        c.setFillColor(MUTED_BLUE)
        c.roundRect(x, top - 22, width, 24, 6, fill=1, stroke=0)
        c.setFillColor(black)
        c.setFont("WeekBodyBold", size)
        c.drawString(x + 7, top - 16, label)

    def finish_page(self) -> None:
        if not self.page_open:
            return
        c = self.canvas
        if self.page_answers:
            text = " | ".join(self.page_answers)
            font_size = 8.5 if len(text) < 60 else 7.2
            text_width = pdfmetrics.stringWidth(text, "WeekCover", font_size)
            pill_width = min(PANEL_W - 70, text_width + 18)
            x = (PAGE_WIDTH - pill_width) / 2
            c.setFillColor(BACKGROUND)
            c.roundRect(x, 40, pill_width, 18, 5, fill=1, stroke=0)
            c.setFillColor(black)
            c.setFont("WeekCover", font_size)
            c.drawCentredString(PAGE_WIDTH / 2, 45.5, text)
        c.setFillColor(black)
        c.setFont("WeekBodyBold", 9)
        c.drawCentredString(PAGE_WIDTH / 2, 9, str(self.page_number))
        c.showPage()
        self.page_open = False

    def render_section(self, section: dict[str, Any]) -> None:
        if section["layout"] == "mcq_two_column":
            self._render_balanced_mcq_section(section)
        else:
            self.begin_page(section)
            for question in section["questions"]:
                self.add_question(question)
            self.finish_page()
        if section.get("hints"):
            self.draw_hints_appendix(section)

    def _render_balanced_mcq_section(self, section: dict[str, Any]) -> None:
        remaining = list(section["questions"])
        capacity = BODY_TOP - BODY_BOTTOM
        while remaining:
            take, split = self._balanced_page_partition(remaining, capacity)
            page_questions = remaining[:take]
            remaining = remaining[take:]
            self.begin_page(section)
            for question in page_questions[:split]:
                self.add_question(question)
            if split < len(page_questions):
                self.column = 1
                self.cursor_y = BODY_TOP
                for question in page_questions[split:]:
                    self.add_question(question)
            self.finish_page()

    def _balanced_page_partition(
        self, questions: list[dict[str, Any]], capacity: float
    ) -> tuple[int, int]:
        heights = [self._question_height(question, COLUMN_WIDTH) for question in questions]
        for take in range(len(heights), 0, -1):
            page_heights = heights[:take]
            candidates: list[tuple[float, int]] = []
            for split in range(1, take + 1):
                left = sum(page_heights[:split])
                right = sum(page_heights[split:])
                if left <= capacity and right <= capacity:
                    candidates.append((abs(left - right), split))
            if candidates:
                _, split = min(candidates)
                return take, split
        raise ValueError(f"question {questions[0]['id']} cannot fit the two-column page")

    def add_question(self, question: dict[str, Any]) -> None:
        width = COLUMN_WIDTH if self.two_column else BODY_RIGHT - BODY_LEFT
        pieces = self._question_paragraphs(question)
        heights = [piece.wrap(width, PAGE_HEIGHT)[1] for piece in pieces]
        image_size = self._image_size(question, width)
        height = self._question_height(question, width, pieces, heights, image_size)
        full_available = BODY_TOP - BODY_BOTTOM
        if not self.two_column and self.section and self.section["layout"] != "mcq_two_column":
            full_available -= 43
        if height > full_available:
            raise ValueError(
                f"question {question['id']} is {height:.1f}pt tall and cannot fit one layout unit"
            )
        if self.cursor_y - height < BODY_BOTTOM:
            self._advance()

        x = BODY_LEFT if not self.two_column or self.column == 0 else PAGE_WIDTH / 2 + COLUMN_GAP / 2
        top = self.cursor_y
        y = top
        for piece, piece_height in zip(pieces, heights, strict=True):
            y -= piece_height
            piece.drawOn(self.canvas, x, y)
            y -= 2
        if image_size[1]:
            y -= image_size[1] + 4
            self._draw_image(question, x, y, image_size)
        self.cursor_y = top - height

        self.layout.append(
            PositionedItem(
                page=self.page_number,
                section_id=str(self.section["id"] if self.section else ""),
                item_id=str(question["id"]),
                column=self.column,
                x=round(x, 2),
                y=round(self.cursor_y, 2),
                width=round(width, 2),
                height=round(height, 2),
            )
        )
        if question["type"] in {"mcq", "multi_select"}:
            labels = question.get("correct_answers") or [question.get("answer")]
            self.page_answers.append(f"{question['number']}-{'/'.join(labels)}")

    def _question_height(
        self,
        question: dict[str, Any],
        width: float,
        pieces: list[Paragraph] | None = None,
        heights: list[float] | None = None,
        image_size: tuple[float, float] | None = None,
    ) -> float:
        measured_pieces = pieces or self._question_paragraphs(question)
        measured_heights = heights or [
            piece.wrap(width, PAGE_HEIGHT)[1] for piece in measured_pieces
        ]
        measured_image = image_size or self._image_size(question, width)
        return (
            sum(measured_heights)
            + max(0, len(measured_pieces) - 1) * 2
            + measured_image[1]
            + 12
        )

    def _advance(self) -> None:
        if self.two_column and self.column == 0:
            self.column = 1
            self.cursor_y = BODY_TOP
            return
        assert self.section is not None
        self.finish_page()
        self.begin_page(self.section)

    def _question_paragraphs(self, question: dict[str, Any]) -> list[Paragraph]:
        result: list[Paragraph] = []
        if question.get("case"):
            result.append(
                Paragraph(
                    f"<b>Case</b><br/>{escape(str(question['case']))}", self.styles["case"]
                )
            )
        source_parts = list(question.get("source_refs", []))
        for ref in question.get("lecture_refs", []):
            slides = ", ".join(str(number) for number in ref["slide_numbers"])
            source_parts.append(f"{ref['lecture_title']}, slide{'s' if len(ref['slide_numbers']) > 1 else ''} {slides}")
        source = ""
        if source_parts:
            source = " <font color='#557A8A' size='8'>(%s)</font>" % escape(
                "; ".join(source_parts)
            )
        style_name = "stem" if question["type"] in {"mcq", "multi_select"} else "seq"
        result.append(
            Paragraph(
                f"<b>{question['number']}. {escape(str(question['stem']))}</b>{source}",
                self.styles[style_name],
            )
        )
        for option in question.get("options", []):
            result.append(
                Paragraph(
                    f"{escape(str(option['label']))}. {escape(str(option['text']))}",
                    self.styles["option"],
                )
            )
        for note in question.get("notes", []):
            result.append(
                Paragraph(
                    escape(str(note["text"])),
                    self.styles["warning" if note["kind"] in {"warning", "source_limit"} else "note"],
                )
            )
        if question.get("answer") and question["type"] in {"explain_why", "ospe", "other"}:
            result.append(
                Paragraph(
                    f"<b>Answer:</b> {escape(str(question['answer']))}",
                    self.styles["answer"],
                )
            )
        if question.get("explanation"):
            result.append(
                Paragraph(
                    f"<b>Explanation:</b> {escape(str(question['explanation']))}",
                    self.styles["explanation"],
                )
            )
        bank = question.get("bank_source")
        if bank:
            details: list[str] = [str(bank["name"])]
            if bank.get("question_number") is not None:
                details.append(f"question {bank['question_number']}")
            if bank.get("page_numbers"):
                pages = ", ".join(str(number) for number in bank["page_numbers"])
                details.append(f"page{'s' if len(bank['page_numbers']) > 1 else ''} {pages}")
            result.append(Paragraph(f"<b>Bank source:</b> {escape(' · '.join(details))}", self.styles["meta"]))
        return result

    def _image_size(self, question: dict[str, Any], width: float) -> tuple[float, float]:
        media = _question_media(question)
        if not media:
            return (0, 0)
        total_height = 0.0
        max_drawn_width = 0.0
        image_budget = max(70.0, 165.0 - (len(media) - 1) * 8)
        per_image_budget = image_budget / len(media)
        for item in media:
            image_path = (ROOT / item["path"]).resolve()
            source_width, source_height = ImageReader(str(image_path)).getSize()
            scale = min(width / source_width, per_image_budget / source_height, 1)
            drawn_width = source_width * scale
            drawn_height = source_height * scale
            max_drawn_width = max(max_drawn_width, drawn_width)
            total_height += drawn_height + (18 if item.get("caption") else 0)
        total_height += max(0, len(media) - 1) * 8
        return (max_drawn_width, total_height)

    def _draw_image(
        self, question: dict[str, Any], x: float, y: float, size: tuple[float, float]
    ) -> None:
        media = _question_media(question)
        image_budget = max(70.0, 165.0 - (len(media) - 1) * 8)
        per_image_budget = image_budget / len(media)
        cursor = y + size[1]
        for item in media:
            image_path = (ROOT / item["path"]).resolve()
            source_width, source_height = ImageReader(str(image_path)).getSize()
            scale = min(size[0] / source_width, per_image_budget / source_height, 1)
            drawn_width = source_width * scale
            drawn_height = source_height * scale
            cursor -= drawn_height
            self.canvas.drawImage(
                str(image_path), x, cursor, width=drawn_width, height=drawn_height, mask="auto"
            )
            if item.get("caption"):
                cursor -= 18
                self.canvas.setFillColor(SLATE)
                self.canvas.setFont("WeekBodyItalic", 8)
                self.canvas.drawString(x, cursor + 5, str(item["caption"])[:110])
            cursor -= 8

    def draw_hints_appendix(self, section: dict[str, Any]) -> None:
        """Append one or more hints pages immediately after their lecture section."""
        self.page_number += 1
        c = self.canvas
        c.setFillColor(BACKGROUND)
        c.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
        c.setFillColor(white)
        c.setStrokeColor(NAVY)
        c.setLineWidth(1.25)
        c.roundRect(PANEL_X, PANEL_Y, PANEL_W, PANEL_H, 16, fill=1, stroke=1)
        c.setFillColor(SLATE)
        c.setFont("WeekTitle", 18)
        title = f"Hints: {section['title']}"
        c.drawCentredString(PAGE_WIDTH / 2, PAGE_HEIGHT - 66, title)
        y = BODY_TOP
        width = BODY_RIGHT - BODY_LEFT
        hint_style = ParagraphStyle(
            "hint",
            parent=self.styles["seq"],
            fontName="WeekBody",
            fontSize=10,
            leading=14,
            leftIndent=16,
            firstLineIndent=-16,
            textColor=HexColor("#263238"),
            spaceAfter=12,
        )
        for index, hint in enumerate(section["hints"], 1):
            heading = escape(str(hint.get("title") or f"Hint {index}"))
            paragraph = Paragraph(f"<b>{index}. {heading}</b><br/>{escape(str(hint['text']))}", hint_style)
            _, height = paragraph.wrap(width, y - BODY_BOTTOM)
            if y - height < BODY_BOTTOM:
                c.setFont("WeekBodyBold", 9)
                c.drawCentredString(PAGE_WIDTH / 2, 9, str(self.page_number))
                c.showPage()
                self.page_number += 1
                c.setFillColor(BACKGROUND)
                c.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
                c.setFillColor(white)
                c.setStrokeColor(NAVY)
                c.roundRect(PANEL_X, PANEL_Y, PANEL_W, PANEL_H, 16, fill=1, stroke=1)
                y = BODY_TOP
            y -= height
            paragraph.drawOn(c, BODY_LEFT, y)
            y -= 10
        c.setFillColor(black)
        c.setFont("WeekBodyBold", 9)
        c.drawCentredString(PAGE_WIDTH / 2, 9, str(self.page_number))
        c.showPage()

    def build(self) -> list[PositionedItem]:
        self.draw_cover()
        for section in self.sections:
            self.render_section(section)
        if self.document.get("closing_page"):
            self.draw_closing_page(self.document["closing_page"])
        self.canvas.save()
        return self.layout

    def draw_closing_page(self, closing_page: dict[str, Any]) -> None:
        """Draw the source-inspired Arabic prayer as the packet's final page."""
        self.page_number += 1
        c = self.canvas
        c.setFillColor(BACKGROUND)
        c.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
        c.setFillColor(white)
        c.setStrokeColor(NAVY)
        c.setLineWidth(1.25)
        c.roundRect(PANEL_X, PANEL_Y, PANEL_W, PANEL_H, 16, fill=1, stroke=1)

        font_size = 18
        leading = 29
        max_width = PANEL_W - 92
        paragraph_lines = [
            self._wrap_arabic(str(text), max_width, "WeekArabic", font_size)
            for text in closing_page["paragraphs"]
        ]
        signoff_lines = self._wrap_arabic(
            str(closing_page["signoff"]), max_width, "WeekArabic", 16
        )
        paragraph_gap = 24
        total_lines = sum(len(lines) for lines in paragraph_lines) + len(signoff_lines)
        total_height = total_lines * leading + len(paragraph_lines) * paragraph_gap
        y = (PAGE_HEIGHT + total_height) / 2 - leading
        c.setFillColor(black)
        c.setFont("WeekArabic", font_size)
        for lines in paragraph_lines:
            for line in lines:
                c.drawCentredString(PAGE_WIDTH / 2, y, self._shape_arabic(line))
                y -= leading
            y -= paragraph_gap
        c.setFont("WeekArabic", 16)
        for line in signoff_lines:
            c.drawCentredString(PAGE_WIDTH / 2, y, self._shape_signoff(line))
            y -= 24

        c.setFillColor(black)
        c.setFont("WeekBodyBold", 9)
        c.drawCentredString(PAGE_WIDTH / 2, 9, str(self.page_number))
        c.showPage()

    @staticmethod
    def _shape_arabic(text: str) -> str:
        return get_display(arabic_reshaper.reshape(text))

    @classmethod
    def _shape_signoff(cls, text: str) -> str:
        if text.rstrip().endswith(":D"):
            arabic = text.rstrip()[:-2].rstrip()
            return f"{cls._shape_arabic(arabic)} :D"
        return cls._shape_arabic(text)

    @classmethod
    def _wrap_arabic(
        cls, text: str, max_width: float, font_name: str, font_size: float
    ) -> list[str]:
        """Wrap logical Arabic words before shaping each final line for display."""
        words = text.split()
        lines: list[str] = []
        current: list[str] = []
        for word in words:
            candidate = " ".join([*current, word])
            visual = cls._shape_arabic(candidate)
            if current and pdfmetrics.stringWidth(visual, font_name, font_size) > max_width:
                lines.append(" ".join(current))
                current = [word]
            else:
                current.append(word)
        if current:
            lines.append(" ".join(current))
        return lines


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", default="sample_packet.json")
    parser.add_argument("--output", help="override output PDF path")
    parser.add_argument(
        "--audit-dir",
        help="directory for layout-plan.json and manifest.json (defaults to output/)",
    )
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    packet = json.loads(input_path.read_text(encoding="utf-8"))
    document = validate_packet(packet)
    register_fonts()

    output_name = str(document.get("output_name") or "week1-template-demo.pdf")
    output_path = Path(args.output).resolve() if args.output else PDF_ROOT / output_name
    output_path.parent.mkdir(parents=True, exist_ok=True)
    renderer = PacketRenderer(output_path, document)
    layout = renderer.build()

    reader = PdfReader(str(output_path))
    if len(reader.pages) < 2:
        raise RuntimeError("rendered PDF unexpectedly contains fewer than two pages")
    extracted = "\n".join((page.extract_text() or "") for page in reader.pages)
    first_section = _lecture_sections(document)[0][1]
    for expected in (str(document["title"]), str(document["week"]), str(first_section["title"])):
        if expected.upper() not in extracted.upper():
            raise RuntimeError(f"rendered PDF text check failed for {expected!r}")

    audit_root = Path(args.audit_dir).resolve() if args.audit_dir else OUTPUT_ROOT
    audit_root.mkdir(parents=True, exist_ok=True)
    layout_path = audit_root / "layout-plan.json"
    layout_path.write_text(
        json.dumps([item.__dict__ for item in layout], indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    manifest = {
        "template_version": "week1-template-v1",
        "schema_version": packet["schema_version"],
        "input": str(input_path),
        "input_sha256": sha256_file(input_path),
        "output": str(output_path),
        "output_sha256": sha256_file(output_path),
        "page_count": len(reader.pages),
        "positioned_items": len(layout),
        "contents_links": renderer.contents_link_count,
        "lecture_count": len({str(lecture["id"]) for lecture, _ in _lecture_sections(document)}),
        "section_count": len(_lecture_sections(document)),
        "question_count": sum(len(section["questions"]) for section in renderer.sections),
        "hint_appendix_count": sum(1 for section in renderer.sections if section.get("hints")),
        "media_count": sum(
            len(_question_media(question))
            for section in renderer.sections
            for question in section["questions"]
        ),
        "fonts": {name: {"path": str(path), "sha256": sha256_file(path)} for name, path in FONT_PATHS.items()},
    }
    (audit_root / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"Rendered {output_path} ({len(reader.pages)} pages, {len(layout)} questions)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
