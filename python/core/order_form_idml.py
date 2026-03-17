"""Order form IDML/PDF template customization.

Takes the master NV Order Form 2026 IDML template and produces
state-specific versions by swapping:
  - State logo PDF (on the shirt graphic)
  - State abbreviation text
  - Deadline dates (postmark, online, ship)

Outputs both IDML (for designer review in InDesign) and PDF
(for use as template in per-athlete order form generation).
"""

import os
import sys
import re
import shutil
import zipfile
import tempfile
import fitz  # PyMuPDF

_BASE_DIR = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
TEMPLATE_DIR = os.path.join(_BASE_DIR, 'templates')
TEMPLATE_IDML = os.path.join(TEMPLATE_DIR, 'order_form_template.idml')
TEMPLATE_PDF = os.path.join(TEMPLATE_DIR, 'order_form_template.pdf')
LOGO_DIR = os.path.join(TEMPLATE_DIR, 'state_logos')

# --- IDML story IDs containing state/date text ---
# Story_u2b6: "NV" (state abbreviation below scissors line)
# Story_u10c: body dates (postmark, online, ship with full year)
# Story_u212: cut-line dates (postmark, ship without year)
# Story_u6bb: pasteboard notes with "NV" (not visible on page)
STATE_STORY = 'u2b6'
BODY_DATES_STORY = 'u10c'
CUT_LINE_STORY = 'u212'
PASTEBOARD_STORY = 'u6bb'

# --- PDF coordinate mapping (from IDML spread analysis) ---
# Page: 612x792 pts.  IDML spread origin offset: (-306, -396)
# Logo rect in PDF coords: calculated from IDML Rectangle u43f
LOGO_TARGET_RECT = fitz.Rect(47.3, 307.4, 140.9, 371.1)
LOGO_SOURCE_CLIP = fitz.Rect(0, 73.2, 792, 612)

# Text positions in the 2026 template PDF
# "NV" below scissors: [42.0, 491.2, 56.4, 504.4]
NV_TEXT_RECT = (41, 490, 73, 505)
NV_TEXT_POS = fitz.Point(42, 501)

# Body dates — word positions measured from 2026 NV template PDF
# "April 4, 2026" at [383.6..443.6], after "before" ending at 381.4
POSTMARK_BODY_RECT = (382, 210, 445, 230)
POSTMARK_BODY_POS = fitz.Point(383, 225)
# "April 8, 2026" at [431.5..493.4], after "through" ending at 429.4
ONLINE_BODY_RECT = (430, 227, 495, 247)
ONLINE_BODY_POS = fitz.Point(431, 242)
# "April 20 2026 or before." at [383.0..492.1] — cover date + trailing text
SHIP_BODY_RECT = (382, 244, 493, 264)
SHIP_BODY_POS = fitz.Point(383, 259)
# "or before." gets re-inserted after the date
SHIP_BODY_SUFFIX = ' or before.'

# Cut-line dates — small caps mixed sizing
# "April 4" at [332.8..378.1]
POSTMARK_CUT_RECT = (331, 487, 380, 513)
POSTMARK_CUT_POS = fitz.Point(332, 507)
# "April 20" at [474.6..505.3]
SHIP_CUT_RECT = (473, 494, 507, 511)
SHIP_CUT_POS = fitz.Point(474, 507)

WHITE = (1, 1, 1)
BLACK = (0, 0, 0)
FONT_BOLD = 'Times-Bold'
FONT_REGULAR = 'Times-Roman'


def _find_logo_path(state, logo_dir=None):
    """Find the logo PDF for a given state identifier."""
    logo_dir = logo_dir or LOGO_DIR
    # Try exact match first (e.g., "NV.pdf", "CA - NorCal.pdf")
    candidate = os.path.join(logo_dir, f'{state}.pdf')
    if os.path.exists(candidate):
        return candidate
    # Try case-insensitive
    for f in os.listdir(logo_dir):
        if f.lower() == f'{state.lower()}.pdf':
            return os.path.join(logo_dir, f)
    return None


def _strip_year(date_str):
    """Strip year from date string for cut-line display.
    'April 4, 2026' → 'April 4'
    'March 15' → 'March 15' (no change)
    """
    # Remove comma + year or just year at end
    return re.sub(r',?\s*\d{4}\s*$', '', date_str).strip()


# ─────────────────────────────────────────────────────
# IDML output
# ─────────────────────────────────────────────────────

def customize_idml(state, postmark_date, online_date, ship_date,
                   output_path, logo_dir=None, template_path=None):
    """Generate a state-specific IDML from the master template.

    Modifies story XML to swap state abbreviation and dates,
    updates the logo link to reference the state's logo PDF.
    Places the logo PDF alongside the output IDML.

    Returns the output IDML path.
    """
    template_path = template_path or TEMPLATE_IDML
    logo_dir = logo_dir or LOGO_DIR
    logo_path = _find_logo_path(state, logo_dir)

    # Read template IDML (ZIP)
    with zipfile.ZipFile(template_path, 'r') as zin:
        members = zin.namelist()
        contents = {name: zin.read(name) for name in members}

    # --- Modify Story_u2b6: "NV" → state ---
    story_key = f'Stories/Story_{STATE_STORY}.xml'
    if story_key in contents:
        xml = contents[story_key].decode('utf-8')
        xml = xml.replace('>NV<', f'>{state}<')
        contents[story_key] = xml.encode('utf-8')

    # --- Modify Story_u10c: body dates ---
    story_key = f'Stories/Story_{BODY_DATES_STORY}.xml'
    if story_key in contents:
        xml = contents[story_key].decode('utf-8')
        xml = xml.replace('April 4, 2026', postmark_date)
        xml = xml.replace('April 8, 2026', online_date)
        xml = xml.replace('April 20 2026', ship_date)
        contents[story_key] = xml.encode('utf-8')

    # --- Modify Story_u212: cut-line dates ---
    story_key = f'Stories/Story_{CUT_LINE_STORY}.xml'
    if story_key in contents:
        xml = contents[story_key].decode('utf-8')
        short_postmark = _strip_year(postmark_date)
        short_ship = _strip_year(ship_date)
        xml = xml.replace('April 4', short_postmark)
        xml = xml.replace('April 20', short_ship)
        contents[story_key] = xml.encode('utf-8')

    # --- Modify Story_u6bb: pasteboard notes ---
    story_key = f'Stories/Story_{PASTEBOARD_STORY}.xml'
    if story_key in contents:
        xml = contents[story_key].decode('utf-8')
        xml = xml.replace('NV ', f'{state} ')
        xml = xml.replace('NV\t', f'{state}\t')
        # Handle line separator character
        xml = xml.replace('NV\u2028', f'{state}\u2028')
        xml = xml.replace('NV\n', f'{state}\n')
        contents[story_key] = xml.encode('utf-8')

    # --- Update logo link in spread ---
    spread_key = 'Spreads/Spread_uc6.xml'
    if spread_key in contents and logo_path:
        xml = contents[spread_key].decode('utf-8')
        # Replace the logo URI with just the filename (relative reference)
        logo_filename = os.path.basename(logo_path)
        xml = re.sub(
            r'LinkResourceURI="[^"]*NV\.pdf"',
            f'LinkResourceURI="{logo_filename}"',
            xml
        )
        contents[spread_key] = xml.encode('utf-8')

    # Write output IDML
    os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
    with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zout:
        for name in members:
            zout.writestr(name, contents[name])

    # Copy logo alongside the IDML so InDesign can find it
    if logo_path:
        out_dir = os.path.dirname(output_path)
        logo_dest = os.path.join(out_dir, os.path.basename(logo_path))
        if not os.path.exists(logo_dest):
            shutil.copy2(logo_path, logo_dest)

    return output_path


# ─────────────────────────────────────────────────────
# PDF output — uses redaction API for clean text replacement
# ─────────────────────────────────────────────────────

# Master template text (what to search for and replace)
_NV_TEMPLATE_TEXT = 'NV'
_POSTMARK_TEMPLATE = 'April 4, 2026'
_ONLINE_TEMPLATE = 'April 8, 2026'
_SHIP_TEMPLATE = 'April 20 2026'
_POSTMARK_CUT_TEMPLATE = 'April 4'
_SHIP_CUT_TEMPLATE = 'April 20'


def _redact_replace(page, old_text, new_text, fontname, fontsize,
                    y_min=None, y_max=None):
    """Find old_text in page, add redaction annotation with new_text.

    y_min/y_max filter matches to a vertical region (e.g. body vs cut-line).
    Call page.apply_redactions() after all replacements are queued.
    """
    hits = page.search_for(old_text)
    for rect in hits:
        if y_min is not None and rect.y0 < y_min:
            continue
        if y_max is not None and rect.y0 > y_max:
            continue
        page.add_redact_annot(rect, text=new_text,
                              fontname=fontname, fontsize=fontsize,
                              align=fitz.TEXT_ALIGN_LEFT)
        return True  # replaced first match in region
    return False


def _apply_text_replacements(page, state, postmark_date, online_date, ship_date):
    """Queue all text redactions for state/date replacement, then apply.

    Uses PyMuPDF's redaction API which removes original text from the
    PDF content stream (no white rectangles) and inserts clean replacement text.
    """
    # State abbreviation (below scissors, y > 480)
    _redact_replace(page, _NV_TEMPLATE_TEXT, state,
                    FONT_REGULAR, 10, y_min=480)

    # Body dates (y between 200 and 280)
    _redact_replace(page, _POSTMARK_TEMPLATE, postmark_date,
                    FONT_BOLD, 12.5, y_min=200, y_max=240)
    _redact_replace(page, _ONLINE_TEMPLATE, online_date,
                    FONT_BOLD, 12.5, y_min=220, y_max=260)
    _redact_replace(page, _SHIP_TEMPLATE, ship_date,
                    FONT_BOLD, 12.5, y_min=240, y_max=280)

    # Cut-line dates (y > 480, small caps area)
    short_postmark = _strip_year(postmark_date)
    short_ship = _strip_year(ship_date)
    # Cut-line postmark: "April 4" around x=332, y=488
    _redact_replace(page, _POSTMARK_CUT_TEMPLATE, short_postmark,
                    FONT_BOLD, 9, y_min=480)
    # Cut-line ship: "April 20" around x=474, y=495
    _redact_replace(page, _SHIP_CUT_TEMPLATE, short_ship,
                    FONT_BOLD, 7, y_min=480)

    page.apply_redactions()


def customize_pdf(state, postmark_date, online_date, ship_date,
                  output_path, logo_dir=None, template_path=None):
    """Generate a state-specific PDF from the master template.

    Primary approach: edit the IDML template (text + logo) then convert
    to PDF via idml_to_pdf(). Falls back to PDF redaction if conversion
    fails.

    Returns the output PDF path.
    """
    from python.core.idml_parser import idml_to_pdf

    idml_template = template_path or TEMPLATE_IDML
    if os.path.exists(idml_template):
        tmp_idml = None
        try:
            fd, tmp_idml = tempfile.mkstemp(suffix='.idml')
            os.close(fd)
            customize_idml(state, postmark_date, online_date, ship_date,
                           tmp_idml, logo_dir, idml_template)
            os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
            idml_to_pdf(tmp_idml, output_path)
            os.unlink(tmp_idml)
            return output_path
        except Exception:
            if tmp_idml and os.path.exists(tmp_idml):
                try:
                    os.unlink(tmp_idml)
                except OSError:
                    pass

    # Fallback: PDF redaction approach
    template_path = template_path or TEMPLATE_PDF
    logo_dir = logo_dir or LOGO_DIR
    logo_path = _find_logo_path(state, logo_dir)

    doc = fitz.open(template_path)
    page = doc[0]

    if logo_path:
        logo_doc = fitz.open(logo_path)
        page.show_pdf_page(LOGO_TARGET_RECT, logo_doc, 0,
                           clip=LOGO_SOURCE_CLIP)
        logo_doc.close()

    _apply_text_replacements(page, state, postmark_date, online_date, ship_date)

    os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
    doc.save(output_path)
    doc.close()
    return output_path


def get_state_template(state, postmark_date='TBD', online_date='TBD',
                       ship_date='TBD', logo_dir=None, template_path=None):
    """Create a state-specific template PDF in memory.

    Returns a fitz.Document that can be used as the template for
    per-athlete order form generation (passed to show_pdf_page).
    The caller is responsible for closing the document.

    Primary approach: IDML conversion. Falls back to PDF redaction.
    """
    from python.core.idml_parser import idml_to_pdf

    idml_template = template_path or TEMPLATE_IDML
    if os.path.exists(idml_template):
        tmp_idml = None
        tmp_pdf = None
        try:
            fd1, tmp_idml = tempfile.mkstemp(suffix='.idml')
            os.close(fd1)
            fd2, tmp_pdf = tempfile.mkstemp(suffix='.pdf')
            os.close(fd2)
            customize_idml(state, postmark_date, online_date, ship_date,
                           tmp_idml, logo_dir, idml_template)
            idml_to_pdf(tmp_idml, tmp_pdf)
            os.unlink(tmp_idml)
            tmp_idml = None
            # Load PDF into memory to avoid Windows file-lock issues
            file_doc = fitz.open(tmp_pdf)
            pdf_bytes = file_doc.tobytes()
            file_doc.close()
            os.unlink(tmp_pdf)
            tmp_pdf = None
            doc = fitz.open("pdf", pdf_bytes)
            return doc
        except Exception:
            for f in (tmp_idml, tmp_pdf):
                if f and os.path.exists(f):
                    try:
                        os.unlink(f)
                    except OSError:
                        pass

    # Fallback: PDF redaction approach
    template_path = template_path or TEMPLATE_PDF
    logo_dir = logo_dir or LOGO_DIR
    logo_path = _find_logo_path(state, logo_dir)

    doc = fitz.open(template_path)
    page = doc[0]

    if logo_path:
        logo_doc = fitz.open(logo_path)
        page.show_pdf_page(LOGO_TARGET_RECT, logo_doc, 0,
                           clip=LOGO_SOURCE_CLIP)
        logo_doc.close()

    _apply_text_replacements(page, state, postmark_date, online_date, ship_date)

    return doc


def generate_both(state, postmark_date, online_date, ship_date,
                  output_dir, logo_dir=None):
    """Generate both IDML and PDF for a state. Returns dict with paths."""
    os.makedirs(output_dir, exist_ok=True)

    idml_path = os.path.join(output_dir, f'{state} Order Form 2026.idml')
    pdf_path = os.path.join(output_dir, f'{state} Order Form 2026.pdf')

    customize_idml(state, postmark_date, online_date, ship_date,
                   idml_path, logo_dir)
    customize_pdf(state, postmark_date, online_date, ship_date,
                  pdf_path, logo_dir)

    return {'idml': idml_path, 'pdf': pdf_path}
