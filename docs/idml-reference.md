# IDML Reference for Adobe InDesign CS6 (DOMVersion 8.0)

Source: IDML File Format Specification Version 8.0 (430 pages), from
https://github.com/jorisros/IDMLlib/blob/master/docs/idml-specification.pdf

## Critical Facts

- **DOMVersion "8.0"** = InDesign CS6
- **All measurements in IDML XML are ALWAYS in points** (1 inch = 72 points)
- Letter page = 612 x 792 points (8.5" x 11")
- IDML package is a **ZIP archive** with `.idml` extension
- Coordinate system: Y increases downward. Spread origin is at center of spread.
- The `mimetype` file MUST be the first file in the ZIP, uncompressed

## IDML Package File Structure

```
myfile.idml (ZIP archive)
├── mimetype
├── META-INF/
│   └── container.xml
├── designmap.xml
├── Resources/
│   ├── Fonts.xml
│   ├── Graphic.xml
│   ├── Styles.xml
│   └── Preferences.xml
├── MasterSpreads/
│   └── MasterSpread_xxx.xml
├── Spreads/
│   └── Spread_xxx.xml
├── Stories/
│   └── Story_xxx.xml
└── XML/
    ├── BackingStory.xml
    ├── Tags.xml
    └── Mapping.xml
```

---

## 1. mimetype

Plain text file, MUST be first in ZIP, stored uncompressed:

```
application/vnd.adobe.indesign-idml-package
```

---

## 2. META-INF/container.xml

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="designmap.xml" media-type="text/xml"/>
  </rootfiles>
</container>
```

---

## 3. designmap.xml

This is the root document. It references all other files and defines document-level attributes.

### Minimal Working designmap.xml

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<?aid style="50" type="document" readerVersion="6.0" featureSet="257" product="8.0(370)" ?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"
  DOMVersion="8.0"
  Self="d"
  StoryList="u100"
  ZeroPoint="0 0"
  ActiveLayer="u10"
  CMYKProfile="U.S. Web Coated (SWOP) v2"
  RGBProfile="sRGB IEC61966-2.1"
  SolidColorIntent="UseColorSettings"
  AfterBlendingIntent="UseColorSettings"
  DefaultImageIntent="UseColorSettings"
  RGBPolicy="PreserveEmbeddedProfiles"
  CMYKPolicy="CombinationOfPreserveAndSafeCmyk"
  AccurateLABSpots="false">

  <idPkg:Graphic src="Resources/Graphic.xml"/>
  <idPkg:Fonts src="Resources/Fonts.xml"/>
  <idPkg:Styles src="Resources/Styles.xml"/>
  <idPkg:Preferences src="Resources/Preferences.xml"/>

  <Language Self="Language/$ID/English%3a USA"
    Name="$ID/English: USA"
    SingleQuotes="&#x2018;&#x2019;"
    DoubleQuotes="&#x201c;&#x201d;"
    PrimaryLanguageName="$ID/English"
    SublanguageName="$ID/USA"
    Id="269"
    HyphenationVendor="Hunspell"
    SpellingVendor="Hunspell"/>

  <idPkg:Tags src="XML/Tags.xml"/>

  <Layer Self="u10" Name="Layer 1" Visible="true" Locked="false"
    IgnoreWrap="false" ShowGuides="true" LockGuides="false"
    UI="true" Expendable="true" Printable="true">
    <Properties>
      <LayerColor type="enumeration">LightBlue</LayerColor>
    </Properties>
  </Layer>

  <idPkg:Spread src="Spreads/Spread_u200.xml"/>

  <Section Self="u300" Length="1" Name="" PageNumberStart="1"
    Marker="" PageStart="u400" SectionPrefix="" IncludeSectionPrefix="false"
    ContinueNumbering="false">
    <Properties>
      <PageNumberStyle type="enumeration">Arabic</PageNumberStyle>
    </Properties>
  </Section>

  <idPkg:BackingStory src="XML/BackingStory.xml"/>
  <idPkg:Story src="Stories/Story_u100.xml"/>

</Document>
```

### Key designmap.xml Rules

- `StoryList` is a space-separated list of Story Self IDs (e.g., `"u100 u101 u102"`)
- `ActiveLayer` must reference a Layer Self value
- `idPkg:Spread src=` references are ordered -- spread order = document page order
- `idPkg:Story src=` references point to Story XML files
- The `Section` element's `PageStart` references a Page Self from a Spread

---

## 4. Spread XML (Spreads/Spread_xxx.xml)

Spreads contain Pages and page items (TextFrame, Rectangle, Oval, GraphicLine, etc.).
**Page items are children of `<Spread>`, NOT children of `<Page>`.**

### Coordinate System

- Spread coordinates: origin is center of the first page on the spread
- For a single Letter page (612x792): the page center is at (0, 0) in spread coords
- `ItemTransform` on `<Page>`: `"1 0 0 1 tx ty"` where tx, ty translate page inner coords to spread coords
- For a single page centered: `ItemTransform="1 0 0 1 0 -396"` (shifts page up by half of 792)
- `GeometricBounds` on `<Page>`: `"top left bottom right"` = `"0 0 792 612"` for Letter (in page inner coords)

### ItemTransform Matrix

Format: `"a b c d tx ty"` where the 3x3 matrix is:
```
| a  b  0 |
| c  d  0 |
| tx ty 1 |
```
- Identity (no transform): `"1 0 0 1 0 0"`
- Translation only: `"1 0 0 1 tx ty"`
- Rotation by angle theta: `a=cos(θ), b=-sin(θ), c=sin(θ), d=cos(θ)`

### Minimal Spread with One Page and One TextFrame

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"
  DOMVersion="8.0">

  <Spread Self="u200"
    FlattenerOverride="Default"
    AllowPageShuffle="true"
    ItemTransform="1 0 0 1 0 0"
    ShowMasterItems="true"
    PageCount="1"
    BindingLocation="0">

    <!-- Page definition (Letter size) -->
    <Page Self="u400"
      GeometricBounds="0 0 792 612"
      ItemTransform="1 0 0 1 0 -396"
      Name="1"
      AppliedTrapPreset="TrapPreset/$ID/kDefaultTrapStyleName"
      OverrideList=""
      AppliedMaster="n"
      MasterPageTransform="1 0 0 1 0 0"
      TabOrder=""
      GridStartingPoint="TopOutside"
      UseMasterGrid="true">
      <Properties>
        <PageColor type="enumeration">UseMasterColor</PageColor>
      </Properties>
      <MarginPreference ColumnCount="1" ColumnGutter="12"
        Top="36" Bottom="36" Left="36" Right="36"
        ColumnDirection="Horizontal" ColumnsPositions="0 540"/>
    </Page>

    <!-- TextFrame: 1-inch margins (72pt from edges) on the page -->
    <!-- Path coords are in the page item's inner coordinate system -->
    <!-- ItemTransform translates to spread coordinates -->
    <TextFrame Self="u500"
      ParentStory="u100"
      PreviousTextFrame="n"
      NextTextFrame="n"
      ContentType="TextType"
      ItemLayer="u10"
      ItemTransform="1 0 0 1 0 -396">
      <Properties>
        <PathGeometry>
          <GeometryPathType PathOpen="false">
            <PathPointArray>
              <PathPointType Anchor="36 36"
                LeftDirection="36 36" RightDirection="36 36"/>
              <PathPointType Anchor="36 756"
                LeftDirection="36 756" RightDirection="36 756"/>
              <PathPointType Anchor="576 756"
                LeftDirection="576 756" RightDirection="576 756"/>
              <PathPointType Anchor="576 36"
                LeftDirection="576 36" RightDirection="576 36"/>
            </PathPointArray>
          </GeometryPathType>
        </PathGeometry>
      </Properties>
      <TextFramePreference TextColumnCount="1" TextColumnGutter="12"
        TextColumnFixedWidth="540"
        UseFixedColumnWidth="false"
        FirstBaselineOffset="AscentOffset"
        MinimumFirstBaselineOffset="0"
        VerticalJustification="TopAlign"
        VerticalThreshold="0"
        IgnoreWrap="false">
        <Properties>
          <InsetSpacing type="list">
            <ListItem type="unit">0</ListItem>
            <ListItem type="unit">0</ListItem>
            <ListItem type="unit">0</ListItem>
            <ListItem type="unit">0</ListItem>
          </InsetSpacing>
        </Properties>
      </TextFramePreference>
    </TextFrame>

  </Spread>
</idPkg:Spread>
```

### PathPointArray for Common Shapes

**For rectangles (TextFrame, Rectangle):** 4 points, clockwise from top-left.
For a rectangle with Anchor, LeftDirection, and RightDirection all identical = straight edges (no curves).

```
TopLeft     → PathPointType Anchor="x1 y1" LeftDirection="x1 y1" RightDirection="x1 y1"
BottomLeft  → PathPointType Anchor="x1 y2" LeftDirection="x1 y2" RightDirection="x1 y2"
BottomRight → PathPointType Anchor="x2 y2" LeftDirection="x2 y2" RightDirection="x2 y2"
TopRight    → PathPointType Anchor="x2 y1" LeftDirection="x2 y1" RightDirection="x2 y1"
```

Where x1,y1 = top-left corner and x2,y2 = bottom-right corner in the item's inner coords.

**For an Oval:** 4 points with Bezier control handles. For a circle inscribed in a bounding box:
- The magic number for circular Bezier approximation: offset = radius * 0.5522847498

```xml
<Oval Self="u600" ItemTransform="1 0 0 1 0 -396" ItemLayer="u10"
  FillColor="Color/Black" StrokeWeight="1" StrokeColor="Color/Black">
  <Properties>
    <PathGeometry>
      <GeometryPathType PathOpen="false">
        <PathPointArray>
          <!-- Top center -->
          <PathPointType Anchor="cx cy1"
            LeftDirection="cx-offset cy1" RightDirection="cx+offset cy1"/>
          <!-- Right center -->
          <PathPointType Anchor="cx2 cy"
            LeftDirection="cx2 cy-offset" RightDirection="cx2 cy+offset"/>
          <!-- Bottom center -->
          <PathPointType Anchor="cx cy2"
            LeftDirection="cx+offset cy2" RightDirection="cx-offset cy2"/>
          <!-- Left center -->
          <PathPointType Anchor="cx1 cy"
            LeftDirection="cx1 cy+offset" RightDirection="cx1 cy-offset"/>
        </PathPointArray>
      </GeometryPathType>
    </PathGeometry>
  </Properties>
</Oval>
```

Actual example from spec (an Oval inside a group):
```xml
<Oval Self="u10f" ItemTransform="1 0 0 1 0 0">
  <Properties>
    <PathGeometry>
      <GeometryPathType PathOpen="false">
        <PathPointArray>
          <PathPointType Anchor="51 -288.5005"
            LeftDirection="42.99187117333334 -288.5005"
            RightDirection="59.00812882666667 -288.5005"/>
          <PathPointType Anchor="65.5 -303.0005"
            LeftDirection="65.5 -294.9923711733333"
            RightDirection="65.5 -311.0086288266666"/>
          <PathPointType Anchor="51 -317.5005"
            LeftDirection="59.00812882666667 -317.5005"
            RightDirection="42.99187117333334 -317.5005"/>
          <PathPointType Anchor="36.5 -303.0005"
            LeftDirection="36.5 -311.0086288266666"
            RightDirection="36.5 -294.9923711733333"/>
        </PathPointArray>
      </GeometryPathType>
    </PathGeometry>
  </Properties>
</Oval>
```

**For a GraphicLine:** 2 points, open path.

```xml
<GraphicLine Self="u700" ItemTransform="1 0 0 1 0 -396"
  ItemLayer="u10" StrokeWeight="1" StrokeColor="Color/Black">
  <Properties>
    <PathGeometry>
      <GeometryPathType PathOpen="true">
        <PathPointArray>
          <PathPointType Anchor="x1 y1"
            LeftDirection="x1 y1" RightDirection="x1 y1"/>
          <PathPointType Anchor="x2 y2"
            LeftDirection="x2 y2" RightDirection="x2 y2"/>
        </PathPointArray>
      </GeometryPathType>
    </PathGeometry>
  </Properties>
</GraphicLine>
```

Note: `PathOpen="true"` for lines, `PathOpen="false"` for closed shapes.

### GeometricBounds vs PathPointArray

- **GeometricBounds** is ONLY used on `<Page>` elements: `"top left bottom right"` format
- **PathPointArray** is used for ALL page items (TextFrame, Rectangle, Oval, GraphicLine, Polygon)
- There is NO GeometricBounds on page items -- you MUST use PathGeometry/PathPointArray
- The path defines the shape; ItemTransform positions it in the parent coordinate system

---

## 5. Story XML (Stories/Story_xxx.xml)

Story files contain text content with formatting. The structure is essentially the same as ICML
(InCopy Markup Language) but wrapped differently.

### Minimal Story

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"
  DOMVersion="8.0">

  <Story Self="u100" AppliedTOCStyle="n" TrackChanges="false"
    StoryTitle="$ID/" AppliedNamedGrid="n">
    <StoryPreference OpticalMarginAlignment="false"
      OpticalMarginSize="12"
      FrameType="TextFrameType"
      StoryOrientation="Horizontal"
      StoryDirection="LeftToRightDirection"/>
    <InCopyExportOption IncludeGraphicProxies="true"
      IncludeAllResources="false"/>

    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
        <Content>Hello World</Content>
      </CharacterStyleRange>
    </ParagraphStyleRange>

  </Story>
</idPkg:Story>
```

### Story with Multiple Paragraphs and Formatting

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"
  DOMVersion="8.0">

  <Story Self="u100" AppliedTOCStyle="n" TrackChanges="false"
    StoryTitle="$ID/" AppliedNamedGrid="n">
    <StoryPreference OpticalMarginAlignment="false"
      OpticalMarginSize="12"
      FrameType="TextFrameType"
      StoryOrientation="Horizontal"
      StoryDirection="LeftToRightDirection"/>
    <InCopyExportOption IncludeGraphicProxies="true"
      IncludeAllResources="false"/>

    <!-- First paragraph: heading -->
    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"
        PointSize="24" FontStyle="Bold">
        <Properties>
          <AppliedFont type="string">Arial</AppliedFont>
        </Properties>
        <Content>Meet Results</Content>
      </CharacterStyleRange>
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
        <Br/>
      </CharacterStyleRange>
    </ParagraphStyleRange>

    <!-- Second paragraph: body text -->
    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"
        PointSize="12" FontStyle="Regular">
        <Properties>
          <AppliedFont type="string">Times New Roman</AppliedFont>
        </Properties>
        <Content>Score details go here.</Content>
      </CharacterStyleRange>
    </ParagraphStyleRange>

  </Story>
</idPkg:Story>
```

### Key Story Rules

- `<Br/>` = paragraph break (like pressing Enter). It goes inside a CharacterStyleRange.
- All text lives inside `<Content>` elements within `<CharacterStyleRange>`
- `<CharacterStyleRange>` lives inside `<ParagraphStyleRange>`
- Font is set via `<AppliedFont type="string">FontFamily</AppliedFont>` in Properties
- Font style (Bold, Italic, etc.) is the `FontStyle` attribute on CharacterStyleRange
- `PointSize` attribute sets font size
- The `Self` value of the Story must match what's in `StoryList` in designmap.xml
- The `Self` value must also match the `ParentStory` attribute on the TextFrame in the Spread

### Story vs ICML

ICML (InCopy) files are essentially single-file IDML stories. The wrapper element differs:

**IDML Story file:**
```xml
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="8.0">
  <Story Self="...">...</Story>
</idPkg:Story>
```

**ICML file:**
```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<?aid style="50" type="snippet" readerVersion="6.0" featureSet="257" product="8.0(370)" ?>
<?aid style="50" type="component" readerVersion="6.0" featureSet="257" product="8.0(370)" ?>
<Story Self="..." ...>
  ...
</Story>
```

The inner `<Story>` content (ParagraphStyleRange, CharacterStyleRange, Content, etc.) is identical.

---

## 6. Resources/Fonts.xml

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Fonts xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"
  DOMVersion="8.0">

  <FontFamily Self="di100" Name="Arial">
    <Font Self="di100Font/Arial Regular" FontFamily="Arial"
      Name="Arial Regular" PostScriptName="ArialMT" Status="Installed"
      FontStyleName="Regular" FontType="TrueType" WritingScript="0"
      FullName="Arial" FullNameNative="Arial"
      FontStyleNameNative="Regular" PlatformName="$ID/"
      Version="Version 7.00"/>
    <Font Self="di100Font/Arial Bold" FontFamily="Arial"
      Name="Arial Bold" PostScriptName="Arial-BoldMT" Status="Installed"
      FontStyleName="Bold" FontType="TrueType" WritingScript="0"
      FullName="Arial Bold" FullNameNative="Arial Bold"
      FontStyleNameNative="Bold" PlatformName="$ID/"
      Version="Version 7.00"/>
    <Font Self="di100Font/Arial Italic" FontFamily="Arial"
      Name="Arial Italic" PostScriptName="Arial-ItalicMT" Status="Installed"
      FontStyleName="Italic" FontType="TrueType" WritingScript="0"
      FullName="Arial Italic" FullNameNative="Arial Italic"
      FontStyleNameNative="Italic" PlatformName="$ID/"
      Version="Version 7.00"/>
    <Font Self="di100Font/Arial Bold Italic" FontFamily="Arial"
      Name="Arial Bold Italic" PostScriptName="Arial-BoldItalicMT" Status="Installed"
      FontStyleName="Bold Italic" FontType="TrueType" WritingScript="0"
      FullName="Arial Bold Italic" FullNameNative="Arial Bold Italic"
      FontStyleNameNative="Bold Italic" PlatformName="$ID/"
      Version="Version 7.00"/>
  </FontFamily>

  <FontFamily Self="di101" Name="Times New Roman">
    <Font Self="di101Font/Times New Roman Regular" FontFamily="Times New Roman"
      Name="Times New Roman Regular" PostScriptName="TimesNewRomanPSMT" Status="Installed"
      FontStyleName="Regular" FontType="TrueType" WritingScript="0"
      FullName="Times New Roman" FullNameNative="Times New Roman"
      FontStyleNameNative="Regular" PlatformName="$ID/"
      Version="Version 7.00"/>
    <Font Self="di101Font/Times New Roman Bold" FontFamily="Times New Roman"
      Name="Times New Roman Bold" PostScriptName="TimesNewRomanPS-BoldMT" Status="Installed"
      FontStyleName="Bold" FontType="TrueType" WritingScript="0"
      FullName="Times New Roman Bold" FullNameNative="Times New Roman Bold"
      FontStyleNameNative="Bold" PlatformName="$ID/"
      Version="Version 7.00"/>
  </FontFamily>

  <!-- Minimal Minion Pro entry (InDesign default) -->
  <FontFamily Self="di102" Name="Minion Pro">
    <Font Self="di102Font/Minion Pro Regular" FontFamily="Minion Pro"
      Name="Minion Pro Regular" PostScriptName="MinionPro-Regular" Status="Installed"
      FontStyleName="Regular" FontType="OpenTypeCFF" WritingScript="0"
      FullName="Minion Pro Regular" FullNameNative="Minion Pro Regular"
      FontStyleNameNative="Regular" PlatformName="$ID/"
      Version="Version 2.030;PS 2.000;hotconv 1.0.51;makeotf.lib2.0.18671"/>
  </FontFamily>

</idPkg:Fonts>
```

### Font Reference Pattern

In stories/styles, fonts are referenced by name:
```xml
<CharacterStyleRange FontStyle="Bold">
  <Properties>
    <AppliedFont type="string">Arial</AppliedFont>
  </Properties>
</CharacterStyleRange>
```

The `AppliedFont` value matches the `Name` attribute of a `<FontFamily>`.
The `FontStyle` attribute matches the `FontStyleName` of a `<Font>`.

---

## 7. Resources/Graphic.xml

Contains colors, swatches, gradients, inks, and stroke styles.

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"
  DOMVersion="8.0">

  <!-- Required swatches -->
  <Swatch Self="Swatch/None" Name="None"
    ColorEditable="false" ColorRemovable="false" Visible="true"
    SwatchCreatorID="7937"/>

  <!-- Required colors -->
  <Color Self="Color/Black" Model="Process" Space="CMYK"
    ColorValue="0 0 0 100" ColorOverride="Specialblack"
    BaseColor="n" AlternateSpace="NoAlternateColor" AlternateColorValue=""
    Name="Black" ColorEditable="false" ColorRemovable="false"
    Visible="true" SwatchCreatorID="7937"/>

  <Color Self="Color/Paper" Model="Process" Space="CMYK"
    ColorValue="0 0 0 0" ColorOverride="Specialpaper"
    BaseColor="n" AlternateSpace="NoAlternateColor" AlternateColorValue=""
    Name="Paper" ColorEditable="false" ColorRemovable="false"
    Visible="true" SwatchCreatorID="7937"/>

  <Color Self="Color/Registration" Model="Process" Space="CMYK"
    ColorValue="100 100 100 100" ColorOverride="Specialregistration"
    BaseColor="n" AlternateSpace="NoAlternateColor" AlternateColorValue=""
    Name="Registration" ColorEditable="false" ColorRemovable="false"
    Visible="true" SwatchCreatorID="7937"/>

  <!-- Custom process color example -->
  <Color Self="Color/C=100 M=0 Y=0 K=0" Model="Process" Space="CMYK"
    ColorValue="100 0 0 0" ColorOverride="Normal"
    BaseColor="n" AlternateSpace="NoAlternateColor" AlternateColorValue=""
    Name="C=100 M=0 Y=0 K=0" ColorEditable="true" ColorRemovable="true"
    Visible="true" SwatchCreatorID="7937"/>

  <!-- RGB color example -->
  <Color Self="Color/R=255 G=0 B=0" Model="Process" Space="RGB"
    ColorValue="255 0 0" ColorOverride="Normal"
    BaseColor="n" AlternateSpace="NoAlternateColor" AlternateColorValue=""
    Name="R=255 G=0 B=0" ColorEditable="true" ColorRemovable="true"
    Visible="true" SwatchCreatorID="7937"/>

  <!-- Required inks -->
  <Ink Self="Ink/Cyan" Name="Cyan" IsProcessInk="true"
    AliasInkName="" Angle="75" ConvertToProcess="false"
    Frequency="70" NeutralDensity="0.61"
    PrintInk="true" TrapOrder="1" InkType="Normal"/>
  <Ink Self="Ink/Magenta" Name="Magenta" IsProcessInk="true"
    AliasInkName="" Angle="15" ConvertToProcess="false"
    Frequency="70" NeutralDensity="0.76"
    PrintInk="true" TrapOrder="2" InkType="Normal"/>
  <Ink Self="Ink/Yellow" Name="Yellow" IsProcessInk="true"
    AliasInkName="" Angle="0" ConvertToProcess="false"
    Frequency="70" NeutralDensity="0.16"
    PrintInk="true" TrapOrder="3" InkType="Normal"/>
  <Ink Self="Ink/Black" Name="Black" IsProcessInk="true"
    AliasInkName="" Angle="45" ConvertToProcess="false"
    Frequency="70" NeutralDensity="1.7"
    PrintInk="true" TrapOrder="4" InkType="Normal"/>

  <!-- Default stroke style -->
  <StrokeStyle Self="StrokeStyle/$ID/Solid" Name="$ID/Solid"/>
  <StrokeStyle Self="StrokeStyle/$ID/Dashed" Name="$ID/Dashed"/>

</idPkg:Graphic>
```

### Color Reference Pattern

In page items:
```xml
<Rectangle FillColor="Color/Black" StrokeColor="Swatch/None" ...>
```

In text:
```xml
<CharacterStyleRange FillColor="Color/C=100 M=0 Y=0 K=0" ...>
```

The `Self` attribute of a Color/Swatch is used as the reference value.

---

## 8. Resources/Styles.xml

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Styles xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"
  DOMVersion="8.0">

  <RootParagraphStyleGroup Self="u69">
    <ParagraphStyle Self="ParagraphStyle/$ID/[No paragraph style]"
      Name="$ID/[No paragraph style]"
      Imported="false" NextStyle="ParagraphStyle/$ID/[No paragraph style]"
      KeyboardShortcut="0 0"/>
    <ParagraphStyle Self="ParagraphStyle/$ID/NormalParagraphStyle"
      Name="$ID/NormalParagraphStyle"
      Imported="false" NextStyle="ParagraphStyle/$ID/NormalParagraphStyle"
      KeyboardShortcut="0 0" PointSize="12" FontStyle="Regular">
      <Properties>
        <AppliedFont type="string">Minion Pro</AppliedFont>
        <Leading type="unit">14.4</Leading>
      </Properties>
    </ParagraphStyle>
  </RootParagraphStyleGroup>

  <RootCharacterStyleGroup Self="u6a">
    <CharacterStyle Self="CharacterStyle/$ID/[No character style]"
      Name="$ID/[No character style]" Imported="false"/>
  </RootCharacterStyleGroup>

  <RootObjectStyleGroup Self="u6b">
    <ObjectStyle Self="ObjectStyle/$ID/[None]" Name="$ID/[None]"/>
    <ObjectStyle Self="ObjectStyle/$ID/[Normal Graphics Frame]"
      Name="$ID/[Normal Graphics Frame]"/>
    <ObjectStyle Self="ObjectStyle/$ID/[Normal Text Frame]"
      Name="$ID/[Normal Text Frame]"/>
  </RootObjectStyleGroup>

  <RootTableStyleGroup Self="u6c">
    <TableStyle Self="TableStyle/$ID/[No table style]"
      Name="$ID/[No table style]"/>
  </RootTableStyleGroup>

  <RootCellStyleGroup Self="u6d">
    <CellStyle Self="CellStyle/$ID/[None]" Name="$ID/[None]"/>
  </RootCellStyleGroup>

</idPkg:Styles>
```

---

## 9. Resources/Preferences.xml

For US Letter (612x792 points, 8.5"x11"):

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Preferences xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"
  DOMVersion="8.0">

  <DocumentPreference Self="d-DocumentPreference1"
    PageHeight="792" PageWidth="612"
    PagesPerDocument="1"
    FacingPages="false"
    DocumentBleedTopOffset="0" DocumentBleedBottomOffset="0"
    DocumentBleedInsideOrLeftOffset="0" DocumentBleedOutsideOrRightOffset="0"
    DocumentBleedUniformSize="true"
    SlugTopOffset="0" SlugBottomOffset="0"
    SlugInsideOrLeftOffset="0" SlugRightOrOutsideOffset="0"
    DocumentSlugUniformSize="false"
    PreserveLayoutWhenShuffling="true"
    AllowPageShuffle="true"
    OverprintBlack="true"
    PageBinding="LeftToRight"
    ColumnDirection="Horizontal"
    ColumnGuideLocked="true"
    MasterTextFrame="false"
    SnippetImportUsesOriginalLocation="false">
    <Properties>
      <ColumnGuideColor type="enumeration">Violet</ColumnGuideColor>
      <MarginGuideColor type="enumeration">Magenta</MarginGuideColor>
    </Properties>
  </DocumentPreference>

  <MarginPreference Self="d-MarginPreference1"
    ColumnCount="1" ColumnGutter="12"
    Top="36" Bottom="36" Left="36" Right="36"
    ColumnDirection="Horizontal" ColumnsPositions="0 540"/>

  <ViewPreference Self="d-ViewPreference1"
    HorizontalMeasurementUnits="Points"
    VerticalMeasurementUnits="Points"
    RulerOrigin="SpineOrigin"
    ShowRulers="true" ShowFrameEdges="true"
    CursorKeyIncrement="1"
    GuideSnaptoZone="4"/>

  <GridPreference Self="d-GridPreference1"
    DocumentGridShown="false" DocumentGridSnapto="false"
    HorizontalGridlineDivision="72" VerticalGridlineDivision="72"
    HorizontalGridSubdivision="8" VerticalGridSubdivision="8"
    GridsInBack="true"
    BaselineGridShown="false" BaselineStart="36"
    BaselineDivision="12" BaselineViewThreshold="75"
    BaselineGridRelativeOption="TopOfPageOfBaselineGridRelativeOption">
    <Properties>
      <GridColor type="enumeration">LightGray</GridColor>
      <BaselineColor type="enumeration">LightBlue</BaselineColor>
    </Properties>
  </GridPreference>

  <GuidePreference Self="d-GuidePreference1"
    GuidesShown="true" GuidesLocked="false" GuidesSnapto="true"
    RulerGuidesIncrementRepeat="true" RulerGuidesViewThreshold="75">
    <Properties>
      <RulerGuidesColor type="enumeration">Cyan</RulerGuidesColor>
    </Properties>
  </GuidePreference>

  <PasteboardPreference Self="d-PasteboardPreference1"
    PasteboardMargins="1 1" MinimumSpaceAboveAndBelow="36">
    <Properties>
      <PreviewBackgroundColor type="enumeration">LightGray</PreviewBackgroundColor>
      <BleedGuideColor type="enumeration">Fiesta</BleedGuideColor>
      <SlugGuideColor type="enumeration">GridBlue</SlugGuideColor>
    </Properties>
  </PasteboardPreference>

  <StoryPreference Self="d-StoryPreference1"
    OpticalMarginAlignment="false" OpticalMarginSize="12"
    FrameType="TextFrameType"
    StoryOrientation="Horizontal"
    StoryDirection="LeftToRightDirection"/>

  <TextPreference Self="d-TextPreference1"
    TypographersQuotes="true"
    HighlightHjViolations="false"
    HighlightKeeps="false"
    HighlightSubstitutedGlyphs="false"
    HighlightCustomSpacing="false"
    HighlightSubstitutedFonts="true"
    UseOpticalSize="true"
    UseParagraphLeading="false"
    SuperscriptSize="58.3" SuperscriptPosition="33.3"
    SubscriptSize="58.3" SubscriptPosition="33.3"
    SmallCap="70"
    LeadingKeyIncrement="2"
    BaselineShiftKeyIncrement="2"
    KerningKeyIncrement="20"
    ShowInvisibles="false"
    JustifyTextWraps="false"/>

  <TextFramePreference Self="d-TextFramePreference1"
    TextColumnCount="1" TextColumnGutter="12"
    TextColumnFixedWidth="0"
    UseFixedColumnWidth="false"
    FirstBaselineOffset="AscentOffset"
    MinimumFirstBaselineOffset="0"
    VerticalJustification="TopAlign"
    VerticalThreshold="0"
    IgnoreWrap="false">
    <Properties>
      <InsetSpacing type="list">
        <ListItem type="unit">0</ListItem>
        <ListItem type="unit">0</ListItem>
        <ListItem type="unit">0</ListItem>
        <ListItem type="unit">0</ListItem>
      </InsetSpacing>
    </Properties>
  </TextFramePreference>

  <TextWrapPreference Self="d-TextWrapPreference1"
    TextWrapMode="None" Inverse="false"
    ApplyToMasterPageOnly="false" TextWrapSide="BothSides">
    <Properties>
      <TextWrapOffset Top="0" Left="0" Bottom="0" Right="0"/>
    </Properties>
    <ContourOption Self="d-TextWrapPreference1ContourOption1"
      ContourType="SameAsClipping" IncludeInsideEdges="false"
      ContourPathName="$ID/"/>
  </TextWrapPreference>

  <TransparencyPreference Self="d-TransparencyPreference1"
    BlendingSpace="CMYK" GlobalLightAngle="120"
    GlobalLightAltitude="30"/>

</idPkg:Preferences>
```

---

## 10. XML/BackingStory.xml

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:BackingStory xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"
  DOMVersion="8.0">
  <XmlStory Self="u800" AppliedTOCStyle="n" TrackChanges="false"
    StoryTitle="$ID/" AppliedNamedGrid="n">
    <StoryPreference OpticalMarginAlignment="false" OpticalMarginSize="12"
      FrameType="TextFrameType" StoryOrientation="Horizontal"
      StoryDirection="LeftToRightDirection"/>
    <InCopyExportOption IncludeGraphicProxies="true" IncludeAllResources="false"/>
    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"/>
    </ParagraphStyleRange>
  </XmlStory>
</idPkg:BackingStory>
```

---

## 11. XML/Tags.xml

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Tags xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"
  DOMVersion="8.0">
</idPkg:Tags>
```

---

## 12. XML/Mapping.xml

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Mapping xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"
  DOMVersion="8.0">
</idPkg:Mapping>
```

---

## 13. Python: Generate a Minimal IDML File

```python
"""
Generate a minimal IDML file for InDesign CS6 (DOMVersion 8.0).
All measurements in points. Letter page = 612x792 pts.
"""
import zipfile
import os

def create_idml(output_path: str, stories: list[dict] = None):
    """
    Create a minimal IDML file.

    Args:
        output_path: Path for the output .idml file
        stories: List of dicts with keys:
            - id: unique story id (e.g., "u100")
            - paragraphs: list of dicts with keys:
                - text: string
                - font: font family name (e.g., "Arial")
                - style: font style (e.g., "Regular", "Bold")
                - size: point size (float)
            - frame: dict with x, y, width, height in points (from page top-left)
    """
    if stories is None:
        stories = [{
            "id": "u100",
            "paragraphs": [{"text": "Hello World", "font": "Arial",
                           "style": "Regular", "size": 12}],
            "frame": {"x": 36, "y": 36, "width": 540, "height": 720}
        }]

    story_ids = " ".join(s["id"] for s in stories)
    layer_id = "u10"

    # --- mimetype ---
    mimetype = "application/vnd.adobe.indesign-idml-package"

    # --- META-INF/container.xml ---
    container_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="designmap.xml" media-type="text/xml"/>
  </rootfiles>
</container>'''

    # --- Build Spread XML ---
    text_frames = []
    for s in stories:
        f = s["frame"]
        x1, y1 = f["x"], f["y"]
        x2, y2 = x1 + f["width"], y1 + f["height"]
        tf_id = f'tf_{s["id"]}'
        text_frames.append(f'''
    <TextFrame Self="{tf_id}" ParentStory="{s['id']}"
      PreviousTextFrame="n" NextTextFrame="n"
      ContentType="TextType" ItemLayer="{layer_id}"
      ItemTransform="1 0 0 1 0 -396">
      <Properties>
        <PathGeometry>
          <GeometryPathType PathOpen="false">
            <PathPointArray>
              <PathPointType Anchor="{x1} {y1}" LeftDirection="{x1} {y1}" RightDirection="{x1} {y1}"/>
              <PathPointType Anchor="{x1} {y2}" LeftDirection="{x1} {y2}" RightDirection="{x1} {y2}"/>
              <PathPointType Anchor="{x2} {y2}" LeftDirection="{x2} {y2}" RightDirection="{x2} {y2}"/>
              <PathPointType Anchor="{x2} {y1}" LeftDirection="{x2} {y1}" RightDirection="{x2} {y1}"/>
            </PathPointArray>
          </GeometryPathType>
        </PathGeometry>
      </Properties>
      <TextFramePreference TextColumnCount="1" TextColumnGutter="12"
        TextColumnFixedWidth="{f['width']}"
        UseFixedColumnWidth="false"
        FirstBaselineOffset="AscentOffset"
        MinimumFirstBaselineOffset="0"
        VerticalJustification="TopAlign"
        VerticalThreshold="0" IgnoreWrap="false">
        <Properties>
          <InsetSpacing type="list">
            <ListItem type="unit">0</ListItem>
            <ListItem type="unit">0</ListItem>
            <ListItem type="unit">0</ListItem>
            <ListItem type="unit">0</ListItem>
          </InsetSpacing>
        </Properties>
      </TextFramePreference>
    </TextFrame>''')

    spread_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"
  DOMVersion="8.0">
  <Spread Self="u200" FlattenerOverride="Default" AllowPageShuffle="true"
    ItemTransform="1 0 0 1 0 0" ShowMasterItems="true"
    PageCount="1" BindingLocation="0">
    <Page Self="u400" GeometricBounds="0 0 792 612"
      ItemTransform="1 0 0 1 0 -396" Name="1"
      AppliedTrapPreset="TrapPreset/$ID/kDefaultTrapStyleName"
      OverrideList="" AppliedMaster="n"
      MasterPageTransform="1 0 0 1 0 0" TabOrder=""
      GridStartingPoint="TopOutside" UseMasterGrid="true">
      <Properties>
        <PageColor type="enumeration">UseMasterColor</PageColor>
      </Properties>
      <MarginPreference ColumnCount="1" ColumnGutter="12"
        Top="36" Bottom="36" Left="36" Right="36"
        ColumnDirection="Horizontal" ColumnsPositions="0 540"/>
    </Page>
    {"".join(text_frames)}
  </Spread>
</idPkg:Spread>'''

    # --- Build Story XML files ---
    story_xmls = {}
    for s in stories:
        paras = []
        for i, p in enumerate(s["paragraphs"]):
            content = p["text"].replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            para = f'''
    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"
        PointSize="{p.get('size', 12)}" FontStyle="{p.get('style', 'Regular')}">
        <Properties>
          <AppliedFont type="string">{p.get('font', 'Arial')}</AppliedFont>
        </Properties>
        <Content>{content}</Content>
      </CharacterStyleRange>'''
            # Add paragraph break between paragraphs (not after last)
            if i < len(s["paragraphs"]) - 1:
                para += '''
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">
        <Br/>
      </CharacterStyleRange>'''
            para += '''
    </ParagraphStyleRange>'''
            paras.append(para)

        story_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"
  DOMVersion="8.0">
  <Story Self="{s['id']}" AppliedTOCStyle="n" TrackChanges="false"
    StoryTitle="$ID/" AppliedNamedGrid="n">
    <StoryPreference OpticalMarginAlignment="false" OpticalMarginSize="12"
      FrameType="TextFrameType" StoryOrientation="Horizontal"
      StoryDirection="LeftToRightDirection"/>
    <InCopyExportOption IncludeGraphicProxies="true" IncludeAllResources="false"/>
    {"".join(paras)}
  </Story>
</idPkg:Story>'''
        story_xmls[s["id"]] = story_xml

    # --- designmap.xml ---
    story_refs = "\n  ".join(
        f'<idPkg:Story src="Stories/Story_{s["id"]}.xml"/>' for s in stories)

    designmap_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<?aid style="50" type="document" readerVersion="6.0" featureSet="257" product="8.0(370)" ?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"
  DOMVersion="8.0" Self="d" StoryList="{story_ids}"
  ZeroPoint="0 0" ActiveLayer="{layer_id}"
  CMYKProfile="U.S. Web Coated (SWOP) v2" RGBProfile="sRGB IEC61966-2.1"
  SolidColorIntent="UseColorSettings" AfterBlendingIntent="UseColorSettings"
  DefaultImageIntent="UseColorSettings" RGBPolicy="PreserveEmbeddedProfiles"
  CMYKPolicy="CombinationOfPreserveAndSafeCmyk" AccurateLABSpots="false">
  <idPkg:Graphic src="Resources/Graphic.xml"/>
  <idPkg:Fonts src="Resources/Fonts.xml"/>
  <idPkg:Styles src="Resources/Styles.xml"/>
  <idPkg:Preferences src="Resources/Preferences.xml"/>
  <Language Self="Language/$ID/English%3a USA" Name="$ID/English: USA"
    SingleQuotes="&#x2018;&#x2019;" DoubleQuotes="&#x201c;&#x201d;"
    PrimaryLanguageName="$ID/English" SublanguageName="$ID/USA"
    Id="269" HyphenationVendor="Hunspell" SpellingVendor="Hunspell"/>
  <idPkg:Tags src="XML/Tags.xml"/>
  <Layer Self="{layer_id}" Name="Layer 1" Visible="true" Locked="false"
    IgnoreWrap="false" ShowGuides="true" LockGuides="false"
    UI="true" Expendable="true" Printable="true">
    <Properties>
      <LayerColor type="enumeration">LightBlue</LayerColor>
    </Properties>
  </Layer>
  <idPkg:Spread src="Spreads/Spread_u200.xml"/>
  <Section Self="u300" Length="1" Name="" PageNumberStart="1"
    Marker="" PageStart="u400" SectionPrefix=""
    IncludeSectionPrefix="false" ContinueNumbering="false">
    <Properties>
      <PageNumberStyle type="enumeration">Arabic</PageNumberStyle>
    </Properties>
  </Section>
  <idPkg:BackingStory src="XML/BackingStory.xml"/>
  {story_refs}
</Document>'''

    # --- Fonts.xml ---
    fonts_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Fonts xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"
  DOMVersion="8.0">
  <FontFamily Self="di100" Name="Arial">
    <Font Self="di100Font/Arial Regular" FontFamily="Arial"
      Name="Arial Regular" PostScriptName="ArialMT" Status="Installed"
      FontStyleName="Regular" FontType="TrueType" WritingScript="0"
      FullName="Arial" FullNameNative="Arial"
      FontStyleNameNative="Regular" PlatformName="$ID/" Version="Version 7.00"/>
    <Font Self="di100Font/Arial Bold" FontFamily="Arial"
      Name="Arial Bold" PostScriptName="Arial-BoldMT" Status="Installed"
      FontStyleName="Bold" FontType="TrueType" WritingScript="0"
      FullName="Arial Bold" FullNameNative="Arial Bold"
      FontStyleNameNative="Bold" PlatformName="$ID/" Version="Version 7.00"/>
    <Font Self="di100Font/Arial Italic" FontFamily="Arial"
      Name="Arial Italic" PostScriptName="Arial-ItalicMT" Status="Installed"
      FontStyleName="Italic" FontType="TrueType" WritingScript="0"
      FullName="Arial Italic" FullNameNative="Arial Italic"
      FontStyleNameNative="Italic" PlatformName="$ID/" Version="Version 7.00"/>
  </FontFamily>
  <FontFamily Self="di101" Name="Minion Pro">
    <Font Self="di101Font/Minion Pro Regular" FontFamily="Minion Pro"
      Name="Minion Pro Regular" PostScriptName="MinionPro-Regular" Status="Installed"
      FontStyleName="Regular" FontType="OpenTypeCFF" WritingScript="0"
      FullName="Minion Pro Regular" FullNameNative="Minion Pro Regular"
      FontStyleNameNative="Regular" PlatformName="$ID/"
      Version="Version 2.030"/>
  </FontFamily>
</idPkg:Fonts>'''

    # --- Graphic.xml ---
    graphic_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"
  DOMVersion="8.0">
  <Swatch Self="Swatch/None" Name="None" ColorEditable="false"
    ColorRemovable="false" Visible="true" SwatchCreatorID="7937"/>
  <Color Self="Color/Black" Model="Process" Space="CMYK"
    ColorValue="0 0 0 100" ColorOverride="Specialblack" BaseColor="n"
    AlternateSpace="NoAlternateColor" AlternateColorValue=""
    Name="Black" ColorEditable="false" ColorRemovable="false"
    Visible="true" SwatchCreatorID="7937"/>
  <Color Self="Color/Paper" Model="Process" Space="CMYK"
    ColorValue="0 0 0 0" ColorOverride="Specialpaper" BaseColor="n"
    AlternateSpace="NoAlternateColor" AlternateColorValue=""
    Name="Paper" ColorEditable="false" ColorRemovable="false"
    Visible="true" SwatchCreatorID="7937"/>
  <Color Self="Color/Registration" Model="Process" Space="CMYK"
    ColorValue="100 100 100 100" ColorOverride="Specialregistration" BaseColor="n"
    AlternateSpace="NoAlternateColor" AlternateColorValue=""
    Name="Registration" ColorEditable="false" ColorRemovable="false"
    Visible="true" SwatchCreatorID="7937"/>
  <Ink Self="Ink/Cyan" Name="Cyan" IsProcessInk="true" AliasInkName=""
    Angle="75" ConvertToProcess="false" Frequency="70"
    NeutralDensity="0.61" PrintInk="true" TrapOrder="1" InkType="Normal"/>
  <Ink Self="Ink/Magenta" Name="Magenta" IsProcessInk="true" AliasInkName=""
    Angle="15" ConvertToProcess="false" Frequency="70"
    NeutralDensity="0.76" PrintInk="true" TrapOrder="2" InkType="Normal"/>
  <Ink Self="Ink/Yellow" Name="Yellow" IsProcessInk="true" AliasInkName=""
    Angle="0" ConvertToProcess="false" Frequency="70"
    NeutralDensity="0.16" PrintInk="true" TrapOrder="3" InkType="Normal"/>
  <Ink Self="Ink/Black" Name="Black" IsProcessInk="true" AliasInkName=""
    Angle="45" ConvertToProcess="false" Frequency="70"
    NeutralDensity="1.7" PrintInk="true" TrapOrder="4" InkType="Normal"/>
  <StrokeStyle Self="StrokeStyle/$ID/Solid" Name="$ID/Solid"/>
</idPkg:Graphic>'''

    # --- Styles.xml ---
    styles_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Styles xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"
  DOMVersion="8.0">
  <RootParagraphStyleGroup Self="u69">
    <ParagraphStyle Self="ParagraphStyle/$ID/[No paragraph style]"
      Name="$ID/[No paragraph style]" Imported="false"
      NextStyle="ParagraphStyle/$ID/[No paragraph style]"
      KeyboardShortcut="0 0"/>
    <ParagraphStyle Self="ParagraphStyle/$ID/NormalParagraphStyle"
      Name="$ID/NormalParagraphStyle" Imported="false"
      NextStyle="ParagraphStyle/$ID/NormalParagraphStyle"
      KeyboardShortcut="0 0" PointSize="12" FontStyle="Regular">
      <Properties>
        <AppliedFont type="string">Minion Pro</AppliedFont>
        <Leading type="unit">14.4</Leading>
      </Properties>
    </ParagraphStyle>
  </RootParagraphStyleGroup>
  <RootCharacterStyleGroup Self="u6a">
    <CharacterStyle Self="CharacterStyle/$ID/[No character style]"
      Name="$ID/[No character style]" Imported="false"/>
  </RootCharacterStyleGroup>
  <RootObjectStyleGroup Self="u6b">
    <ObjectStyle Self="ObjectStyle/$ID/[None]" Name="$ID/[None]"/>
    <ObjectStyle Self="ObjectStyle/$ID/[Normal Graphics Frame]"
      Name="$ID/[Normal Graphics Frame]"/>
    <ObjectStyle Self="ObjectStyle/$ID/[Normal Text Frame]"
      Name="$ID/[Normal Text Frame]"/>
  </RootObjectStyleGroup>
  <RootTableStyleGroup Self="u6c">
    <TableStyle Self="TableStyle/$ID/[No table style]"
      Name="$ID/[No table style]"/>
  </RootTableStyleGroup>
  <RootCellStyleGroup Self="u6d">
    <CellStyle Self="CellStyle/$ID/[None]" Name="$ID/[None]"/>
  </RootCellStyleGroup>
</idPkg:Styles>'''

    # --- Preferences.xml ---
    preferences_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Preferences xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"
  DOMVersion="8.0">
  <DocumentPreference Self="d-DocumentPreference1"
    PageHeight="792" PageWidth="612" PagesPerDocument="1"
    FacingPages="false" DocumentBleedTopOffset="0"
    DocumentBleedBottomOffset="0" DocumentBleedInsideOrLeftOffset="0"
    DocumentBleedOutsideOrRightOffset="0" DocumentBleedUniformSize="true"
    SlugTopOffset="0" SlugBottomOffset="0" SlugInsideOrLeftOffset="0"
    SlugRightOrOutsideOffset="0" DocumentSlugUniformSize="false"
    PreserveLayoutWhenShuffling="true" AllowPageShuffle="true"
    OverprintBlack="true" PageBinding="LeftToRight"
    ColumnDirection="Horizontal" ColumnGuideLocked="true"
    MasterTextFrame="false" SnippetImportUsesOriginalLocation="false">
    <Properties>
      <ColumnGuideColor type="enumeration">Violet</ColumnGuideColor>
      <MarginGuideColor type="enumeration">Magenta</MarginGuideColor>
    </Properties>
  </DocumentPreference>
  <MarginPreference Self="d-MarginPreference1" ColumnCount="1"
    ColumnGutter="12" Top="36" Bottom="36" Left="36" Right="36"
    ColumnDirection="Horizontal" ColumnsPositions="0 540"/>
  <ViewPreference Self="d-ViewPreference1"
    HorizontalMeasurementUnits="Points" VerticalMeasurementUnits="Points"
    RulerOrigin="SpineOrigin" ShowRulers="true" ShowFrameEdges="true"
    CursorKeyIncrement="1" GuideSnaptoZone="4"/>
  <GridPreference Self="d-GridPreference1"
    DocumentGridShown="false" DocumentGridSnapto="false"
    HorizontalGridlineDivision="72" VerticalGridlineDivision="72"
    HorizontalGridSubdivision="8" VerticalGridSubdivision="8"
    GridsInBack="true" BaselineGridShown="false" BaselineStart="36"
    BaselineDivision="12" BaselineViewThreshold="75"
    BaselineGridRelativeOption="TopOfPageOfBaselineGridRelativeOption">
    <Properties>
      <GridColor type="enumeration">LightGray</GridColor>
      <BaselineColor type="enumeration">LightBlue</BaselineColor>
    </Properties>
  </GridPreference>
  <PasteboardPreference Self="d-PasteboardPreference1"
    PasteboardMargins="1 1" MinimumSpaceAboveAndBelow="36">
    <Properties>
      <PreviewBackgroundColor type="enumeration">LightGray</PreviewBackgroundColor>
      <BleedGuideColor type="enumeration">Fiesta</BleedGuideColor>
      <SlugGuideColor type="enumeration">GridBlue</SlugGuideColor>
    </Properties>
  </PasteboardPreference>
  <StoryPreference Self="d-StoryPreference1"
    OpticalMarginAlignment="false" OpticalMarginSize="12"
    FrameType="TextFrameType" StoryOrientation="Horizontal"
    StoryDirection="LeftToRightDirection"/>
  <TextPreference Self="d-TextPreference1"
    TypographersQuotes="true" HighlightSubstitutedFonts="true"
    UseParagraphLeading="false" SmallCap="70"
    SuperscriptSize="58.3" SuperscriptPosition="33.3"
    SubscriptSize="58.3" SubscriptPosition="33.3"/>
  <TextFramePreference Self="d-TextFramePreference1"
    TextColumnCount="1" TextColumnGutter="12"
    UseFixedColumnWidth="false" FirstBaselineOffset="AscentOffset"
    MinimumFirstBaselineOffset="0" VerticalJustification="TopAlign"
    VerticalThreshold="0" IgnoreWrap="false">
    <Properties>
      <InsetSpacing type="list">
        <ListItem type="unit">0</ListItem>
        <ListItem type="unit">0</ListItem>
        <ListItem type="unit">0</ListItem>
        <ListItem type="unit">0</ListItem>
      </InsetSpacing>
    </Properties>
  </TextFramePreference>
  <TextWrapPreference Self="d-TextWrapPreference1"
    TextWrapMode="None" Inverse="false"
    ApplyToMasterPageOnly="false" TextWrapSide="BothSides">
    <Properties>
      <TextWrapOffset Top="0" Left="0" Bottom="0" Right="0"/>
    </Properties>
    <ContourOption Self="d-TextWrapPreference1ContourOption1"
      ContourType="SameAsClipping" IncludeInsideEdges="false"
      ContourPathName="$ID/"/>
  </TextWrapPreference>
  <TransparencyPreference Self="d-TransparencyPreference1"
    BlendingSpace="CMYK" GlobalLightAngle="120" GlobalLightAltitude="30"/>
</idPkg:Preferences>'''

    # --- BackingStory.xml ---
    backing_story_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:BackingStory xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"
  DOMVersion="8.0">
  <XmlStory Self="u800" AppliedTOCStyle="n" TrackChanges="false"
    StoryTitle="$ID/" AppliedNamedGrid="n">
    <StoryPreference OpticalMarginAlignment="false" OpticalMarginSize="12"
      FrameType="TextFrameType" StoryOrientation="Horizontal"
      StoryDirection="LeftToRightDirection"/>
    <InCopyExportOption IncludeGraphicProxies="true" IncludeAllResources="false"/>
    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"/>
    </ParagraphStyleRange>
  </XmlStory>
</idPkg:BackingStory>'''

    # --- Tags.xml ---
    tags_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Tags xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"
  DOMVersion="8.0">
</idPkg:Tags>'''

    # --- Mapping.xml ---
    mapping_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Mapping xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"
  DOMVersion="8.0">
</idPkg:Mapping>'''

    # === Write ZIP ===
    with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        # mimetype MUST be first, stored (not compressed)
        zf.writestr('mimetype', mimetype, compress_type=zipfile.ZIP_STORED)
        zf.writestr('META-INF/container.xml', container_xml)
        zf.writestr('designmap.xml', designmap_xml)
        zf.writestr('Resources/Fonts.xml', fonts_xml)
        zf.writestr('Resources/Graphic.xml', graphic_xml)
        zf.writestr('Resources/Styles.xml', styles_xml)
        zf.writestr('Resources/Preferences.xml', preferences_xml)
        zf.writestr('Spreads/Spread_u200.xml', spread_xml)
        for sid, sxml in story_xmls.items():
            zf.writestr(f'Stories/Story_{sid}.xml', sxml)
        zf.writestr('XML/BackingStory.xml', backing_story_xml)
        zf.writestr('XML/Tags.xml', tags_xml)
        zf.writestr('XML/Mapping.xml', mapping_xml)

    print(f"Created: {output_path}")


if __name__ == "__main__":
    create_idml(
        "hello_world.idml",
        stories=[{
            "id": "u100",
            "paragraphs": [
                {"text": "Hello World", "font": "Arial", "style": "Bold", "size": 24},
                {"text": "This is a minimal IDML document generated from Python.",
                 "font": "Arial", "style": "Regular", "size": 12},
            ],
            "frame": {"x": 36, "y": 36, "width": 540, "height": 720}
        }]
    )
```

---

## Quick Reference: Common Page Sizes in Points

| Size | Width | Height |
|------|-------|--------|
| Letter | 612 | 792 |
| Legal | 612 | 1008 |
| Tabloid | 792 | 1224 |
| A4 | 595.276 | 841.89 |
| A3 | 841.89 | 1190.55 |

## Quick Reference: Self Attribute Naming

- Story: `u100`, `u101`, etc. (or any unique string)
- Spread: `u200`, etc.
- Page: `u400`, etc.
- TextFrame: `tf_u100`, etc.
- Layer: `u10`
- Color: `Color/Black`, `Color/C=100 M=0 Y=0 K=0`
- Style: `ParagraphStyle/$ID/NormalParagraphStyle`
- Swatch: `Swatch/None`

The `Self` values just need to be unique strings. InDesign uses `u` + hex UID convention but any string works.
