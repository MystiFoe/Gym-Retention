import 'dart:io';
import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:excel/excel.dart' hide Border;
import 'package:csv/csv.dart';
import '../services/api_service.dart';
import '../models/models.dart';

// ============================================================================
// COLUMN KEYWORD MAPPING
// Maps canonical field names to lists of keywords found in header cells.
// The first header cell that contains any keyword (case-insensitive) wins.
// ============================================================================
const Map<String, List<String>> _columnKeywords = {
  'name':                   ['name', 'member', 'full name', 'fullname', 'member name'],
  'phone':                  ['phone', 'mobile', 'contact', 'cell', 'number', 'ph'],
  'email':                  ['email', 'e-mail', 'mail'],
  'membership_expiry_date': ['expiry', 'expire', 'end date', 'valid till', 'valid upto', 'membership end', 'expiration'],
  'plan_fee':               ['fee', 'amount', 'plan fee', 'plan amount', 'charge', 'price', 'cost'],
  'last_visit_date':        ['last visit', 'visit date', 'last seen', 'attended'],
};

// ============================================================================
// SCREEN
// ============================================================================
class BulkImportScreen extends StatefulWidget {
  const BulkImportScreen({super.key});

  @override
  State<BulkImportScreen> createState() => _BulkImportScreenState();
}

class _BulkImportScreenState extends State<BulkImportScreen> {
  // ── File state ──────────────────────────────────────────────────────────────
  String? _fileName;
  List<String> _headers = [];
  List<List<dynamic>> _rawRows = []; // all data rows (without header)

  // ── Column mapping: canonical field → chosen header index (or -1 = skip) ──
  final Map<String, int?> _columnMap = {
    'name': null,
    'phone': null,
    'email': null,
    'membership_expiry_date': null,
    'plan_fee': null,
    'last_visit_date': null,
  };

  // ── Staff selection ────────────────────────────────────────────────────────
  List<Staff> _trainers = [];
  String? _selectedTrainerId;

  // ── Upload state ─────────────────────────────────────────────────────────────
  int _uploadedRows = 0;
  int _totalRows = 0;

  // ── Result state ──────────────────────────────────────────────────────────────
  Map<String, dynamic>? _result;
  String? _error;

  // ── Steps ─────────────────────────────────────────────────────────────────────
  // 0 = pick file, 1 = map columns, 2 = uploading, 3 = done
  int _step = 0;

  @override
  void initState() {
    super.initState();
    _loadTrainers();
  }

  Future<void> _loadTrainers() async {
    try {
      final res = await ApiService().getStaff(limit: 200);
      if (mounted) setState(() => _trainers = res.staff);
    } catch (_) {}
  }

  // ── File picking ─────────────────────────────────────────────────────────────
  Future<void> _pickFile() async {
    setState(() { _error = null; });
    try {
      final result = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: ['xlsx', 'xls', 'csv'],
        withData: true,
      );
      if (result == null || result.files.isEmpty) return;

      final file = result.files.first;
      final ext = file.extension?.toLowerCase() ?? '';
      final bytes = file.bytes ?? await File(file.path!).readAsBytes();

      List<String> headers = [];
      List<List<dynamic>> rows = [];

      if (ext == 'csv') {
        // Normalise line endings so the parser handles both \r\n and \n
        final content = String.fromCharCodes(bytes)
            .replaceAll('\r\n', '\n')
            .replaceAll('\r', '\n');
        final table = const CsvToListConverter(eol: '\n').convert(content);
        if (table.isEmpty) throw Exception('CSV file is empty');
        headers = table.first.map((c) => c.toString().trim()).toList();
        rows = table.sublist(1);
      } else {
        final excel = Excel.decodeBytes(bytes);
        final sheet = excel.sheets.values.first;
        final allRows = sheet.rows;
        if (allRows.isEmpty) throw Exception('Excel file is empty');
        headers = allRows.first
            .map((c) => (c?.value ?? '').toString().trim())
            .toList();
        rows = allRows.sublist(1).map((r) => r.map((c) => c?.value).toList()).toList();
      }

      // Remove completely empty rows
      rows = rows.where((r) => r.any((c) => c != null && c.toString().trim().isNotEmpty)).toList();

      // Auto-detect column mapping
      final autoMap = _autoDetectColumns(headers);

      if (mounted) {
        setState(() {
          _fileName = file.name;
          _headers = headers;
          _rawRows = rows;
          _columnMap.addAll(autoMap);
          _step = 1;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = 'Failed to read file: $e');
    }
  }

  Map<String, int?> _autoDetectColumns(List<String> headers) {
    final result = <String, int?>{};
    for (final field in _columnKeywords.keys) {
      final keywords = _columnKeywords[field]!;
      int? found;
      for (int i = 0; i < headers.length; i++) {
        final h = headers[i].toLowerCase();
        if (keywords.any((kw) => h.contains(kw))) {
          found = i;
          break;
        }
      }
      result[field] = found;
    }
    return result;
  }

  // ── Build mapped rows from raw data ──────────────────────────────────────────
  List<Map<String, dynamic>> _buildMappedRows() {
    return _rawRows.map((row) {
      final m = <String, dynamic>{};
      for (final field in _columnMap.keys) {
        final idx = _columnMap[field];
        if (idx == null || idx < 0 || idx >= row.length) continue;
        final val = row[idx];
        if (val == null || val.toString().trim().isEmpty) continue;
        final str = val.toString().trim();
        if (field == 'plan_fee') {
          m[field] = double.tryParse(str) ?? 0.0;
        } else {
          m[field] = str;
        }
      }
      return m;
    }).toList();
  }

  // ── Upload ────────────────────────────────────────────────────────────────────
  Future<void> _startUpload() async {
    if (_columnMap['name'] == null) {
      _showError('Please map the "Name" column — it is required.');
      return;
    }

    final mappedRows = _buildMappedRows();
    // Filter out rows with no name
    final validRows = mappedRows.where((r) => (r['name'] as String?)?.isNotEmpty == true).toList();

    setState(() {
      _step = 2;
      _totalRows = validRows.length;
      _uploadedRows = 0;
      _result = null;
      _error = null;
    });

    try {
      final result = await ApiService().bulkImportCustomers(
        validRows,
        staffId: _selectedTrainerId,
        chunkSize: 2000,
        onProgress: (sent, total) {
          if (mounted) setState(() => _uploadedRows = sent);
        },
      );
      if (mounted) {
        setState(() {
          _result = result;
          _step = 3;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _step = 1; // back to mapping step so user can retry
        });
      }
    }
  }

  void _showError(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), backgroundColor: Colors.red.shade700),
    );
  }

  void _reset() {
    setState(() {
      _fileName = null;
      _headers = [];
      _rawRows = [];
      for (final k in _columnMap.keys) { _columnMap[k] = null; }
      _selectedTrainerId = null;
      _uploadedRows = 0;
      _totalRows = 0;
      _result = null;
      _error = null;
      _step = 0;
    });
  }

  // ── UI ────────────────────────────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Bulk Import Customers'),
        actions: [
          if (_step > 0 && _step < 3)
            TextButton.icon(
              icon: const Icon(Icons.refresh, size: 18),
              label: const Text('Reset'),
              onPressed: _reset,
              style: TextButton.styleFrom(foregroundColor: Colors.white),
            ),
        ],
      ),
      body: SafeArea(
        child: _buildBody(),
      ),
    );
  }

  Widget _buildBody() {
    switch (_step) {
      case 0: return _buildPickStep();
      case 1: return _buildMapStep();
      case 2: return _buildUploadingStep();
      case 3: return _buildResultStep();
      default: return _buildPickStep();
    }
  }

  // ── Step 0: Pick file ────────────────────────────────────────────────────────
  Widget _buildPickStep() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.upload_file, size: 72, color: Colors.blueGrey),
            const SizedBox(height: 24),
            const Text('Import Customers from Excel or CSV',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                textAlign: TextAlign.center),
            const SizedBox(height: 8),
            const Text(
              'Supported: .xlsx, .xls, .csv\nAny number of rows (even 1M+)',
              textAlign: TextAlign.center,
              style: TextStyle(color: Colors.grey),
            ),
            const SizedBox(height: 32),
            ElevatedButton.icon(
              icon: const Icon(Icons.folder_open),
              label: const Text('Choose File'),
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 14),
              ),
              onPressed: _pickFile,
            ),
            if (_error != null) ...[
              const SizedBox(height: 16),
              Text(_error!, style: const TextStyle(color: Colors.red), textAlign: TextAlign.center),
            ],
            const SizedBox(height: 32),
            _buildFormatHint(),
          ],
        ),
      ),
    );
  }

  Widget _buildFormatHint() {
    return Card(
      color: Colors.blue.shade50,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Column auto-detection', style: TextStyle(fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            for (final entry in _columnKeywords.entries)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 160,
                      child: Text(
                        _fieldLabel(entry.key),
                        style: const TextStyle(fontWeight: FontWeight.w500, fontSize: 12),
                      ),
                    ),
                    Expanded(
                      child: Text(
                        entry.value.join(', '),
                        style: const TextStyle(fontSize: 12, color: Colors.blueGrey),
                      ),
                    ),
                  ],
                ),
              ),
            const SizedBox(height: 8),
            const Text(
              'Only "Name" is required. Missing phone/subscription end/fee are filled automatically.',
              style: TextStyle(fontSize: 12, color: Colors.grey),
            ),
          ],
        ),
      ),
    );
  }

  // ── Step 1: Map columns ───────────────────────────────────────────────────────
  Widget _buildMapStep() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // File summary
          Card(
            child: ListTile(
              leading: const Icon(Icons.insert_drive_file, color: Colors.green),
              title: Text(_fileName ?? ''),
              subtitle: Text('${_rawRows.length} data rows  •  ${_headers.length} columns detected'),
            ),
          ),
          const SizedBox(height: 16),

          // Column mapping
          const Text('Column Mapping', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
          const SizedBox(height: 4),
          const Text(
            'Map each field to a column from your file. Auto-detected columns are pre-filled.',
            style: TextStyle(color: Colors.grey, fontSize: 13),
          ),
          const SizedBox(height: 12),
          ..._columnMap.keys.map(_buildColumnMapRow),

          const SizedBox(height: 24),

          // Staff selection
          const Text('Staff Assignment (Optional)',
              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
          const SizedBox(height: 4),
          const Text(
            'Leave empty to assign imported customers to admin/no staff.',
            style: TextStyle(color: Colors.grey, fontSize: 13),
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            initialValue: _selectedTrainerId,
            decoration: const InputDecoration(
              labelText: 'Assign to Staff',
              border: OutlineInputBorder(),
              prefixIcon: Icon(Icons.person),
            ),
            items: [
              const DropdownMenuItem(value: null, child: Text('No Staff (Admin manages)')),
              ..._trainers.map((t) => DropdownMenuItem(value: t.id, child: Text(t.name))),
            ],
            onChanged: (v) => setState(() => _selectedTrainerId = v),
          ),

          const SizedBox(height: 24),

          // Error if any
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 16),
              child: Text(_error!, style: const TextStyle(color: Colors.red)),
            ),

          // Upload button
          SizedBox(
            width: double.infinity,
            child: ElevatedButton.icon(
              icon: const Icon(Icons.cloud_upload),
              label: Text('Import ${_rawRows.length} Customers'),
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 14),
                backgroundColor: Colors.green,
                foregroundColor: Colors.white,
              ),
              onPressed: _startUpload,
            ),
          ),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              icon: const Icon(Icons.arrow_back),
              label: const Text('Choose Different File'),
              onPressed: _reset,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildColumnMapRow(String field) {
    final isRequired = field == 'name';
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        children: [
          SizedBox(
            width: 160,
            child: Text(
              '${_fieldLabel(field)}${isRequired ? ' *' : ''}',
              style: TextStyle(
                fontWeight: isRequired ? FontWeight.bold : FontWeight.normal,
                fontSize: 13,
              ),
            ),
          ),
          Expanded(
            child: DropdownButtonFormField<int>(
              initialValue: _columnMap[field],
              isExpanded: true,
              decoration: InputDecoration(
                border: const OutlineInputBorder(),
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                isDense: true,
                errorText: isRequired && _columnMap[field] == null ? 'Required' : null,
              ),
              items: [
                const DropdownMenuItem<int>(value: null, child: Text('— Skip —')),
                ..._headers.asMap().entries.map((e) =>
                    DropdownMenuItem<int>(value: e.key, child: Text(e.value, overflow: TextOverflow.ellipsis))),
              ],
              onChanged: (v) => setState(() => _columnMap[field] = v),
            ),
          ),
        ],
      ),
    );
  }

  // ── Step 2: Uploading ─────────────────────────────────────────────────────────
  Widget _buildUploadingStep() {
    final progress = _totalRows > 0 ? _uploadedRows / _totalRows : 0.0;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_upload, size: 64, color: Colors.blue),
            const SizedBox(height: 24),
            const Text('Uploading…', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
            const SizedBox(height: 16),
            LinearProgressIndicator(value: progress, minHeight: 8),
            const SizedBox(height: 12),
            Text(
              '$_uploadedRows / $_totalRows rows sent',
              style: const TextStyle(color: Colors.grey),
            ),
            const SizedBox(height: 8),
            const Text(
              'Please wait. Large files may take a moment.',
              style: TextStyle(color: Colors.grey, fontSize: 12),
            ),
          ],
        ),
      ),
    );
  }

  // ── Step 3: Result ────────────────────────────────────────────────────────────
  Widget _buildResultStep() {
    final imported = _result?['imported'] as int? ?? 0;
    final skipped = _result?['skipped'] as int? ?? 0;
    final failed = _result?['failed'] as int? ?? 0;
    final errors = (_result?['errors'] as List?)?.cast<String>() ?? [];

    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        children: [
          const Icon(Icons.check_circle, size: 72, color: Colors.green),
          const SizedBox(height: 16),
          const Text('Import Complete!',
              style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
          const SizedBox(height: 24),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              _statCard('Imported', imported, Colors.green),
              _statCard('Skipped', skipped, Colors.orange),
              _statCard('Failed', failed, Colors.red),
            ],
          ),
          if (errors.isNotEmpty) ...[
            const SizedBox(height: 24),
            const Align(
              alignment: Alignment.centerLeft,
              child: Text('Errors / Warnings',
                  style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
            ),
            const SizedBox(height: 8),
            Container(
              decoration: BoxDecoration(
                color: Colors.red.shade50,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Colors.red.shade200),
              ),
              height: 200,
              child: ListView.separated(
                padding: const EdgeInsets.all(12),
                itemCount: errors.length,
                separatorBuilder: (_, _) => const Divider(height: 8),
                itemBuilder: (_, i) => Text(
                  errors[i],
                  style: const TextStyle(fontSize: 12, color: Colors.red),
                ),
              ),
            ),
          ],
          const SizedBox(height: 32),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton.icon(
              icon: const Icon(Icons.arrow_back),
              label: const Text('Back to Customers'),
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 14),
              ),
              onPressed: () => Navigator.of(context).pop(true), // true = refresh
            ),
          ),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              icon: const Icon(Icons.upload_file),
              label: const Text('Import Another File'),
              onPressed: _reset,
            ),
          ),
        ],
      ),
    );
  }

  Widget _statCard(String label, int count, Color color) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
        child: Column(
          children: [
            Text(
              count.toString(),
              style: TextStyle(fontSize: 32, fontWeight: FontWeight.bold, color: color),
            ),
            const SizedBox(height: 4),
            Text(label, style: const TextStyle(color: Colors.grey)),
          ],
        ),
      ),
    );
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  String _fieldLabel(String field) {
    switch (field) {
      case 'name':                   return 'Name';
      case 'phone':                  return 'Phone';
      case 'email':                  return 'Email';
      case 'membership_expiry_date': return 'Subscription End Date';
      case 'plan_fee':               return 'Plan Fee';
      case 'last_visit_date':        return 'Last Visit Date';
      default:                       return field;
    }
  }
}
