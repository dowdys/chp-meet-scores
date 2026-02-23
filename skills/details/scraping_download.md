# Detail: Document Download Approach

## Steps
1. **Find download links**: Look for buttons or links offering PDF, CSV, or Excel downloads:
   ```javascript
   () => {
     const links = [...document.querySelectorAll('a[href]')];
     return links
       .filter(a => /\.(pdf|csv|xlsx?|tsv)/i.test(a.href) || /download|export|report/i.test(a.textContent))
       .map(a => ({ text: a.textContent.trim(), href: a.href }));
   }
   ```
2. **Click download button**: Use `chrome_click` on the identified button/link.
3. **Monitor for download**: The file downloads to `C:\Users\goduk\Downloads\`. Check for new files after clicking.
4. **Copy to workspace**:
   ```bash
   cp "/mnt/c/Users/goduk/Downloads/[FILENAME]" /home/goduk/chp-meet-scores/data/[meet_slug]/
   ```
5. **Process the file**: Route to the appropriate Python adapter based on file type:
   - PDF: Use the PDF adapter (PyMuPDF coordinate extraction)
   - CSV/TSV: Parse directly or use the HTML adapter's TSV parser
   - Excel: Convert to CSV first using Python `openpyxl` or `pandas`
