import 'dart:convert';
import 'dart:typed_data';
import 'package:excel/excel.dart';

/// A single parsed row: column-name → value (all strings, dates normalized to YYYY-MM-DD).
typedef ParsedRow = Map<String, String>;

class ExcelParseResult {
  final List<String> headers;
  final List<ParsedRow> rows;
  final String? error;

  const ExcelParseResult({
    required this.headers,
    required this.rows,
    this.error,
  });
}

/// Parse an Excel (.xlsx) or CSV (.csv / .txt) file from raw bytes.
/// [filename] is used to detect the file format by extension.
ExcelParseResult parseFileBytes(Uint8List bytes, String filename) {
  try {
    if (filename.toLowerCase().endsWith('.csv') ||
        filename.toLowerCase().endsWith('.txt')) {
      return _parseCsv(utf8.decode(bytes, allowMalformed: true));
    }
    return _parseExcel(bytes);
  } catch (e) {
    return ExcelParseResult(headers: [], rows: [], error: 'Could not read file: $e');
  }
}

// ---------------------------------------------------------------------------
// Excel (.xlsx) parser
// ---------------------------------------------------------------------------

ExcelParseResult _parseExcel(Uint8List bytes) {
  final excel = Excel.decodeBytes(bytes);
  if (excel.tables.isEmpty) {
    return const ExcelParseResult(
        headers: [], rows: [], error: 'The file has no sheets');
  }

  // Use first non-empty sheet
  Sheet? sheet;
  for (final s in excel.tables.values) {
    if (s.rows.isNotEmpty) {
      sheet = s;
      break;
    }
  }
  if (sheet == null || sheet.rows.isEmpty) {
    return const ExcelParseResult(headers: [], rows: []);
  }

  // First row → headers (lowercased, whitespace-trimmed)
  final rawHeaders = sheet.rows[0];
  final headers = <String>[];
  for (final cell in rawHeaders) {
    final h = _cellString(cell).toLowerCase().replaceAll(RegExp(r'\s+'), '_');
    headers.add(h);
  }
  // Drop trailing empty headers
  while (headers.isNotEmpty && headers.last.isEmpty) {
    headers.removeLast();
  }

  if (headers.isEmpty) {
    return const ExcelParseResult(
        headers: [], rows: [], error: 'No column headers found in first row');
  }

  final rows = <ParsedRow>[];
  for (int i = 1; i < sheet.rows.length; i++) {
    final row = sheet.rows[i];
    final map = <String, String>{};
    bool hasData = false;

    for (int j = 0; j < headers.length; j++) {
      final val = j < row.length ? _cellString(row[j]) : '';
      if (val.isNotEmpty) hasData = true;
      map[headers[j]] = val;
    }

    if (hasData) rows.add(map);
  }

  return ExcelParseResult(headers: headers, rows: rows);
}

/// Convert an Excel Data cell to a plain string, handling all CellValue types.
String _cellString(Data? cell) {
  if (cell == null || cell.value == null) return '';
  final v = cell.value!;

  // Date/DateTime cells — render as YYYY-MM-DD so the backend gets the right format
  if (v is DateTimeCellValue) {
    final dt = v.asDateTimeLocal();
    return '${dt.year}-${_pad(dt.month)}-${_pad(dt.day)}';
  }
  if (v is DateCellValue) {
    return '${v.year}-${_pad(v.month)}-${_pad(v.day)}';
  }
  if (v is TimeCellValue) {
    return v.toString();
  }
  if (v is DoubleCellValue) {
    // Drop trailing .0 for whole numbers so plan_fee looks clean
    final d = v.value;
    if (d == d.truncateToDouble()) return d.toInt().toString();
    return d.toString();
  }
  return v.toString().trim();
}

String _pad(int n) => n.toString().padLeft(2, '0');

// ---------------------------------------------------------------------------
// CSV parser — handles quoted fields and CRLF/LF line endings
// ---------------------------------------------------------------------------

ExcelParseResult _parseCsv(String content) {
  // Normalise BOM
  if (content.startsWith('\uFEFF')) content = content.substring(1);

  final lines = content.split(RegExp(r'\r?\n'));
  if (lines.isEmpty) {
    return const ExcelParseResult(headers: [], rows: []);
  }

  // Skip leading blank lines
  int start = 0;
  while (start < lines.length && lines[start].trim().isEmpty) start++;
  if (start >= lines.length) return const ExcelParseResult(headers: [], rows: []);

  final headers = _csvSplit(lines[start])
      .map((h) => h.trim().toLowerCase().replaceAll(RegExp(r'\s+'), '_'))
      .toList();
  while (headers.isNotEmpty && headers.last.isEmpty) headers.removeLast();

  if (headers.isEmpty) {
    return const ExcelParseResult(
        headers: [], rows: [], error: 'No column headers found');
  }

  final rows = <ParsedRow>[];
  for (int i = start + 1; i < lines.length; i++) {
    final line = lines[i];
    if (line.trim().isEmpty) continue;

    final values = _csvSplit(line);
    final map = <String, String>{};
    bool hasData = false;

    for (int j = 0; j < headers.length; j++) {
      final val = j < values.length ? values[j].trim() : '';
      if (val.isNotEmpty) hasData = true;
      map[headers[j]] = val;
    }

    if (hasData) rows.add(map);
  }

  return ExcelParseResult(headers: headers, rows: rows);
}

List<String> _csvSplit(String line) {
  final result = <String>[];
  final current = StringBuffer();
  bool inQuotes = false;

  for (int i = 0; i < line.length; i++) {
    final ch = line[i];
    if (ch == '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] == '"') {
        current.write('"');
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch == ',' && !inQuotes) {
      result.add(current.toString());
      current.clear();
    } else {
      current.write(ch);
    }
  }
  result.add(current.toString());
  return result;
}

// ---------------------------------------------------------------------------
// Date normalization helper
// Accepts: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, MM/DD/YYYY
// Returns: YYYY-MM-DD or null if unparseable
// ---------------------------------------------------------------------------
String? normalizeDate(String? input) {
  if (input == null || input.trim().isEmpty) return null;
  final s = input.trim();

  // Already YYYY-MM-DD
  if (RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(s)) return s;

  // DD/MM/YYYY or DD-MM-YYYY (Indian format — most likely)
  final dmySlash = RegExp(r'^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$');
  final m1 = dmySlash.firstMatch(s);
  if (m1 != null) {
    final day = m1.group(1)!.padLeft(2, '0');
    final month = m1.group(2)!.padLeft(2, '0');
    final year = m1.group(3)!;
    // Validate range to decide if it's DD/MM or MM/DD
    final dayInt = int.parse(day);
    final monthInt = int.parse(month);
    if (dayInt > 12 && monthInt <= 12) {
      // Must be DD/MM/YYYY
      return '$year-$month-$day';
    } else {
      // Ambiguous — assume DD/MM/YYYY (Indian standard)
      return '$year-$month-$day';
    }
  }

  // YYYY/MM/DD
  final ymdSlash = RegExp(r'^(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})$');
  final m2 = ymdSlash.firstMatch(s);
  if (m2 != null) {
    final year = m2.group(1)!;
    final month = m2.group(2)!.padLeft(2, '0');
    final day = m2.group(3)!.padLeft(2, '0');
    return '$year-$month-$day';
  }

  return null; // unparseable
}
