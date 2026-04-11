import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import '../models/models.dart';
import '../services/api_service.dart';
import '../utils/excel_parser.dart';
import '../utils/file_download.dart';

// ============================================================================
// Public entry points
// ============================================================================

/// Open the bulk members import dialog.
Future<void> showMembersImportDialog(
  BuildContext context, {
  required List<Trainer> trainers,
  required VoidCallback onSuccess,
}) {
  return showDialog(
    context: context,
    barrierDismissible: false,
    builder: (_) => _BulkImportDialog(
      isMembers: true,
      trainers: trainers,
      onSuccess: onSuccess,
    ),
  );
}

/// Open the bulk trainers import dialog.
Future<void> showTrainersImportDialog(
  BuildContext context, {
  required VoidCallback onSuccess,
}) {
  return showDialog(
    context: context,
    barrierDismissible: false,
    builder: (_) => _BulkImportDialog(
      isMembers: false,
      trainers: const [],
      onSuccess: onSuccess,
    ),
  );
}

// ============================================================================
// Internal dialog state
// ============================================================================

enum _Step { idle, preview, importing, done }

class _ImportResult {
  final int imported;
  final int skipped;
  final List<_RowError> errors;
  final String? defaultPassword; // trainers only
  const _ImportResult({
    required this.imported,
    required this.skipped,
    required this.errors,
    this.defaultPassword,
  });
}

class _RowError {
  final int row;
  final String name;
  final String error;
  const _RowError({required this.row, required this.name, required this.error});
}

class _ValidatedRow {
  final Map<String, String> raw;
  final String? validationError;
  const _ValidatedRow({required this.raw, this.validationError});
  bool get isValid => validationError == null;
}

// ============================================================================
// Dialog widget
// ============================================================================

class _BulkImportDialog extends StatefulWidget {
  final bool isMembers;
  final List<Trainer> trainers;
  final VoidCallback onSuccess;

  const _BulkImportDialog({
    required this.isMembers,
    required this.trainers,
    required this.onSuccess,
  });

  @override
  State<_BulkImportDialog> createState() => _BulkImportDialogState();
}

class _BulkImportDialogState extends State<_BulkImportDialog> {
  _Step _step = _Step.idle;
  String? _fileName;
  List<_ValidatedRow> _rows = [];
  String? _parseError;
  String? _selectedTrainerId;
  _ImportResult? _result;
  String? _importError;

  // ── Template CSVs ──────────────────────────────────────────────────────────

  static const _membersCsvTemplate =
      'name,phone,email,plan_fee,membership_expiry_date,last_visit_date\n'
      'Rahul Sharma,9876543210,rahul@example.com,1500,2025-12-31,2025-04-01\n'
      'Priya Singh,9876543211,,1200,2025-11-30,\n';

  static const _trainersCsvTemplate =
      'name,phone,email\n'
      'Raj Kumar,9876543210,raj@example.com\n'
      'Anita Patel,9876543211,anita@example.com\n';

  // ── File pick ─────────────────────────────────────────────────────────────

  Future<void> _pickFile() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['xlsx', 'csv', 'xls'],
      withData: true, // always populate bytes (works on web + mobile)
    );
    if (result == null || result.files.isEmpty) return;

    final file = result.files.first;
    final bytes = file.bytes;
    if (bytes == null) {
      setState(() => _parseError = 'Could not read file bytes');
      return;
    }

    _processFile(bytes, file.name);
  }

  void _processFile(Uint8List bytes, String name) {
    final parsed = parseFileBytes(bytes, name);

    if (parsed.error != null) {
      setState(() {
        _parseError = parsed.error;
        _step = _Step.idle;
      });
      return;
    }

    if (parsed.rows.isEmpty) {
      setState(() {
        _parseError = 'No data rows found. Make sure the file has a header row and at least one data row.';
        _step = _Step.idle;
      });
      return;
    }

    final validated = widget.isMembers
        ? _validateMemberRows(parsed.rows)
        : _validateTrainerRows(parsed.rows);

    setState(() {
      _fileName = name;
      _rows = validated;
      _parseError = null;
      _step = _Step.preview;
      if (widget.trainers.isNotEmpty) {
        _selectedTrainerId = widget.trainers.first.id;
      }
    });
  }

  // ── Row validation (client-side, before sending to backend) ───────────────

  List<_ValidatedRow> _validateMemberRows(List<ParsedRow> rows) {
    return rows.map((r) {
      final name = r['name']?.trim() ?? '';
      final phone = r['phone']?.trim() ?? '';
      final fee = r['plan_fee']?.trim() ?? r['fee']?.trim() ?? '';
      final expiry = r['membership_expiry_date']?.trim() ??
          r['expiry_date']?.trim() ??
          r['expiry']?.trim() ??
          '';

      if (name.isEmpty) return _ValidatedRow(raw: r, validationError: 'Name is required');
      if (name.length < 2) return _ValidatedRow(raw: r, validationError: 'Name too short');
      if (phone.isEmpty) return _ValidatedRow(raw: r, validationError: 'Phone is required');
      final cleanPhone = phone.replaceAll(RegExp(r'[\s\-+()]'), '');
      if (!RegExp(r'^\d{10,15}$').hasMatch(cleanPhone)) {
        return _ValidatedRow(raw: r, validationError: 'Phone must be 10–15 digits');
      }
      if (fee.isEmpty) return _ValidatedRow(raw: r, validationError: 'plan_fee is required');
      if (double.tryParse(fee) == null || double.parse(fee) <= 0) {
        return _ValidatedRow(raw: r, validationError: 'plan_fee must be a positive number');
      }
      if (expiry.isEmpty) return _ValidatedRow(raw: r, validationError: 'membership_expiry_date is required');
      final normalizedExpiry = normalizeDate(expiry);
      if (normalizedExpiry == null) {
        return _ValidatedRow(raw: r, validationError: 'Invalid expiry date (use YYYY-MM-DD or DD/MM/YYYY)');
      }

      // Normalize dates and phone in the row map before sending
      final cleaned = Map<String, String>.from(r);
      cleaned['phone'] = cleanPhone;
      cleaned['membership_expiry_date'] = normalizedExpiry;
      final rawLastVisit = r['last_visit_date']?.trim() ?? '';
      cleaned['last_visit_date'] = normalizeDate(rawLastVisit) ?? '';
      cleaned['plan_fee'] = fee;

      return _ValidatedRow(raw: cleaned);
    }).toList();
  }

  List<_ValidatedRow> _validateTrainerRows(List<ParsedRow> rows) {
    return rows.map((r) {
      final name = r['name']?.trim() ?? '';
      final phone = r['phone']?.trim() ?? '';
      final email = r['email']?.trim() ?? '';

      if (name.isEmpty) return _ValidatedRow(raw: r, validationError: 'Name is required');
      if (phone.isEmpty) return _ValidatedRow(raw: r, validationError: 'Phone is required');
      final cleanPhone = phone.replaceAll(RegExp(r'[\s\-+()]'), '');
      if (!RegExp(r'^\d{10,15}$').hasMatch(cleanPhone)) {
        return _ValidatedRow(raw: r, validationError: 'Phone must be 10–15 digits');
      }
      if (email.isEmpty) return _ValidatedRow(raw: r, validationError: 'Email is required');
      if (!RegExp(r'^[\w\.\-\+]+@[\w\-]+\.\w{2,}$').hasMatch(email)) {
        return _ValidatedRow(raw: r, validationError: 'Invalid email address');
      }

      final cleaned = Map<String, String>.from(r);
      cleaned['phone'] = cleanPhone;
      return _ValidatedRow(raw: cleaned);
    }).toList();
  }

  // ── Import ─────────────────────────────────────────────────────────────────

  Future<void> _runImport() async {
    final validRows = _rows.where((r) => r.isValid).toList();
    if (validRows.isEmpty) return;

    setState(() {
      _step = _Step.importing;
      _importError = null;
    });

    try {
      Map<String, dynamic> data;
      if (widget.isMembers) {
        data = await ApiService().bulkImportMembers(
          trainerId: _selectedTrainerId!,
          members: validRows.map((r) => r.raw).toList(),
        );
      } else {
        data = await ApiService().bulkImportTrainers(
          trainers: validRows.map((r) => r.raw).toList(),
        );
      }

      // Merge client-side validation errors with server-side errors
      final serverErrors = (data['errors'] as List<dynamic>? ?? [])
          .map((e) => _RowError(
                row: (e['row'] as num).toInt(),
                name: e['name']?.toString() ?? '',
                error: e['error']?.toString() ?? '',
              ))
          .toList();

      setState(() {
        _result = _ImportResult(
          imported: (data['imported'] as num).toInt(),
          skipped: (data['skipped'] as num).toInt(),
          errors: serverErrors,
          defaultPassword: data['defaultPassword']?.toString(),
        );
        _step = _Step.done;
      });

      if ((data['imported'] as num).toInt() > 0) {
        widget.onSuccess();
      }
    } catch (e) {
      setState(() {
        _importError = e.toString();
        _step = _Step.preview;
      });
    }
  }

  // ── Template download ──────────────────────────────────────────────────────

  Future<void> _downloadTemplate() async {
    final csv = widget.isMembers ? _membersCsvTemplate : _trainersCsvTemplate;
    final name = widget.isMembers ? 'members_template.csv' : 'trainers_template.csv';
    await downloadFile(csv.codeUnits, name, 'text/csv');
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final title = widget.isMembers ? 'Import Members' : 'Import Trainers';

    return Dialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520, maxHeight: 680),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Header
            Container(
              padding: const EdgeInsets.fromLTRB(20, 20, 12, 16),
              decoration: BoxDecoration(
                color: const Color(0xFF2196F3).withValues(alpha: 0.06),
                borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.upload_file, color: Color(0xFF2196F3), size: 22),
                  const SizedBox(width: 10),
                  Text(title,
                      style: const TextStyle(
                          fontSize: 17, fontWeight: FontWeight.bold)),
                  const Spacer(),
                  if (_step != _Step.importing)
                    IconButton(
                      icon: const Icon(Icons.close, size: 20),
                      onPressed: () => Navigator.of(context).pop(),
                    ),
                ],
              ),
            ),
            // Body
            Flexible(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(20),
                child: _buildBody(),
              ),
            ),
            // Footer buttons
            if (_step != _Step.importing) _buildFooter(context),
          ],
        ),
      ),
    );
  }

  Widget _buildBody() {
    switch (_step) {
      case _Step.idle:
        return _buildIdleBody();
      case _Step.preview:
        return _buildPreviewBody();
      case _Step.importing:
        return _buildImportingBody();
      case _Step.done:
        return _buildDoneBody();
    }
  }

  // ── Step 1: Idle ───────────────────────────────────────────────────────────

  Widget _buildIdleBody() {
    final columns = widget.isMembers
        ? 'name · phone · email (optional) · plan_fee · membership_expiry_date · last_visit_date (optional)'
        : 'name · phone · email';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Colors.blue.shade50,
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: Colors.blue.shade200),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Row(children: [
                Icon(Icons.info_outline, size: 16, color: Color(0xFF1565C0)),
                SizedBox(width: 6),
                Text('How to import',
                    style: TextStyle(
                        fontWeight: FontWeight.bold,
                        color: Color(0xFF1565C0),
                        fontSize: 13)),
              ]),
              const SizedBox(height: 8),
              const Text(
                '1. Download the template below\n'
                '2. Fill in your data (keep the header row)\n'
                '3. Save as .xlsx or .csv\n'
                '4. Upload the file',
                style: TextStyle(fontSize: 13, height: 1.6),
              ),
              const SizedBox(height: 8),
              Text('Required columns: $columns',
                  style: TextStyle(
                      fontSize: 12, color: Colors.blue.shade800, height: 1.5)),
              if (widget.isMembers) ...[
                const SizedBox(height: 4),
                Text(
                  'Date format: YYYY-MM-DD or DD/MM/YYYY',
                  style: TextStyle(fontSize: 12, color: Colors.blue.shade700),
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 16),

        // Download template
        OutlinedButton.icon(
          icon: const Icon(Icons.download, size: 18),
          label: const Text('Download Template (.csv)'),
          style: OutlinedButton.styleFrom(
            minimumSize: const Size(double.infinity, 44),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          ),
          onPressed: _downloadTemplate,
        ),
        const SizedBox(height: 10),

        // Pick file
        ElevatedButton.icon(
          icon: const Icon(Icons.upload_file, size: 18),
          label: const Text('Select Excel or CSV File'),
          style: ElevatedButton.styleFrom(
            minimumSize: const Size(double.infinity, 48),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          ),
          onPressed: _pickFile,
        ),

        if (_parseError != null) ...[
          const SizedBox(height: 12),
          _ErrorBanner(_parseError!),
        ],
      ],
    );
  }

  // ── Step 2: Preview ────────────────────────────────────────────────────────

  Widget _buildPreviewBody() {
    final validRows = _rows.where((r) => r.isValid).toList();
    final invalidRows = _rows.where((r) => !r.isValid).toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // File name chip
        Row(children: [
          const Icon(Icons.insert_drive_file_outlined,
              size: 16, color: Colors.grey),
          const SizedBox(width: 6),
          Flexible(
            child: Text(_fileName ?? '',
                style: TextStyle(color: Colors.grey[700], fontSize: 13),
                overflow: TextOverflow.ellipsis),
          ),
          const SizedBox(width: 8),
          TextButton.icon(
            icon: const Icon(Icons.change_circle_outlined, size: 15),
            label: const Text('Change', style: TextStyle(fontSize: 12)),
            style:
                TextButton.styleFrom(visualDensity: VisualDensity.compact),
            onPressed: _pickFile,
          ),
        ]),
        const SizedBox(height: 12),

        // Summary chips
        Wrap(spacing: 8, runSpacing: 6, children: [
          _SummaryChip(
              Icons.check_circle, '${validRows.length} ready', Colors.green),
          if (invalidRows.isNotEmpty)
            _SummaryChip(Icons.warning_rounded,
                '${invalidRows.length} invalid', Colors.orange),
        ]),
        const SizedBox(height: 14),

        // Trainer selector (members only)
        if (widget.isMembers) ...[
          const Text('Assign all imported members to:',
              style:
                  TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
          const SizedBox(height: 6),
          DropdownButtonFormField<String>(
            initialValue: _selectedTrainerId,
            decoration: InputDecoration(
              border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8)),
              contentPadding:
                  const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              isDense: true,
            ),
            items: widget.trainers
                .map((t) => DropdownMenuItem(value: t.id, child: Text(t.name)))
                .toList(),
            onChanged: (v) => setState(() => _selectedTrainerId = v),
          ),
          const SizedBox(height: 14),
        ],

        // Preview table (valid rows, first 5)
        if (validRows.isNotEmpty) ...[
          Text('Preview (first ${validRows.length > 5 ? 5 : validRows.length} rows):',
              style: const TextStyle(
                  fontWeight: FontWeight.w600, fontSize: 13)),
          const SizedBox(height: 6),
          _PreviewTable(
              rows: validRows.take(5).toList(), isMembers: widget.isMembers),
          if (validRows.length > 5)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                '...and ${validRows.length - 5} more rows',
                style: TextStyle(color: Colors.grey[600], fontSize: 12),
              ),
            ),
        ],

        // Invalid row errors
        if (invalidRows.isNotEmpty) ...[
          const SizedBox(height: 14),
          Text('${invalidRows.length} row(s) will be skipped:',
              style: const TextStyle(
                  fontWeight: FontWeight.w600,
                  fontSize: 13,
                  color: Colors.orange)),
          const SizedBox(height: 6),
          ...invalidRows.take(5).map((r) => Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  const Icon(Icons.remove_circle_outline,
                      size: 15, color: Colors.orange),
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      '${r.raw['name'] ?? 'Row'}: ${r.validationError}',
                      style: const TextStyle(fontSize: 12),
                    ),
                  ),
                ]),
              )),
          if (invalidRows.length > 5)
            Text('...and ${invalidRows.length - 5} more',
                style: TextStyle(color: Colors.grey[600], fontSize: 12)),
        ],

        if (_importError != null) ...[
          const SizedBox(height: 10),
          _ErrorBanner(_importError!),
        ],
      ],
    );
  }

  // ── Step 3: Importing ──────────────────────────────────────────────────────

  Widget _buildImportingBody() {
    final validCount = _rows.where((r) => r.isValid).length;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const SizedBox(height: 16),
        const CircularProgressIndicator(),
        const SizedBox(height: 16),
        Text('Importing $validCount row(s)...',
            style: const TextStyle(fontSize: 15)),
        const SizedBox(height: 24),
      ],
    );
  }

  // ── Step 4: Done ───────────────────────────────────────────────────────────

  Widget _buildDoneBody() {
    final r = _result!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Success banner
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: r.imported > 0 ? Colors.green.shade50 : Colors.orange.shade50,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
                color: r.imported > 0
                    ? Colors.green.shade300
                    : Colors.orange.shade300),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                Icon(
                    r.imported > 0
                        ? Icons.check_circle
                        : Icons.warning_rounded,
                    color: r.imported > 0 ? Colors.green : Colors.orange,
                    size: 22),
                const SizedBox(width: 8),
                Text(
                  r.imported > 0 ? 'Import complete!' : 'Nothing imported',
                  style: TextStyle(
                      fontWeight: FontWeight.bold,
                      fontSize: 15,
                      color: r.imported > 0
                          ? Colors.green.shade800
                          : Colors.orange.shade800),
                ),
              ]),
              const SizedBox(height: 8),
              _ResultRow(Icons.check_circle_outline, '${r.imported} imported',
                  Colors.green),
              if (r.skipped > 0)
                _ResultRow(
                    Icons.skip_next, '${r.skipped} skipped', Colors.orange),
            ],
          ),
        ),

        // Default password notice for trainers
        if (r.defaultPassword != null && r.imported > 0) ...[
          const SizedBox(height: 14),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.amber.shade50,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: Colors.amber.shade300),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Row(children: [
                  Icon(Icons.key, size: 16, color: Colors.amber),
                  SizedBox(width: 6),
                  Text('Default Password for Imported Trainers',
                      style: TextStyle(
                          fontWeight: FontWeight.bold, fontSize: 13)),
                ]),
                const SizedBox(height: 6),
                SelectableText(
                  r.defaultPassword!,
                  style: const TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 2),
                ),
                const SizedBox(height: 6),
                const Text(
                  'Share this with each trainer. They can change it via Forgot Password.',
                  style: TextStyle(fontSize: 12, color: Colors.black54),
                ),
              ],
            ),
          ),
        ],

        // Server-side errors
        if (r.errors.isNotEmpty) ...[
          const SizedBox(height: 14),
          const Text('Skipped rows:',
              style: TextStyle(
                  fontWeight: FontWeight.w600,
                  fontSize: 13,
                  color: Colors.orange)),
          const SizedBox(height: 6),
          ...r.errors.take(8).map((e) => Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Icon(Icons.remove_circle_outline,
                          size: 14, color: Colors.orange),
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(
                          'Row ${e.row} (${e.name}): ${e.error}',
                          style: const TextStyle(fontSize: 12),
                        ),
                      ),
                    ]),
              )),
          if (r.errors.length > 8)
            Text('...and ${r.errors.length - 8} more',
                style: TextStyle(color: Colors.grey[600], fontSize: 12)),
        ],
      ],
    );
  }

  // ── Footer buttons ─────────────────────────────────────────────────────────

  Widget _buildFooter(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
      child: _step == _Step.idle
          ? Align(
              alignment: Alignment.centerRight,
              child: TextButton(
                onPressed: () => Navigator.of(context).pop(),
                child: const Text('Cancel'),
              ),
            )
          : _step == _Step.preview
              ? Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                  TextButton(
                    onPressed: () => setState(() {
                      _step = _Step.idle;
                      _rows = [];
                      _fileName = null;
                      _importError = null;
                    }),
                    child: const Text('Back'),
                  ),
                  const SizedBox(width: 8),
                  ElevatedButton.icon(
                    icon: const Icon(Icons.upload, size: 18),
                    label: Text(
                        'Import ${_rows.where((r) => r.isValid).length} rows'),
                    onPressed: () {
                      final validRows = _rows.where((r) => r.isValid).toList();
                      if (validRows.isEmpty) return;
                      if (widget.isMembers && _selectedTrainerId == null) return;
                      _runImport();
                    },
                  ),
                ])
              : // done
              Align(
                  alignment: Alignment.centerRight,
                  child: ElevatedButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('Done'),
                  ),
                ),
    );
  }
}

// ============================================================================
// Small reusable widgets
// ============================================================================

class _ErrorBanner extends StatelessWidget {
  final String message;
  const _ErrorBanner(this.message);

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: Colors.red.shade50,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: Colors.red.shade300),
      ),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Icon(Icons.error_outline, color: Colors.red, size: 16),
        const SizedBox(width: 8),
        Flexible(
            child: Text(message,
                style:
                    const TextStyle(color: Colors.red, fontSize: 13))),
      ]),
    );
  }
}

class _SummaryChip extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  const _SummaryChip(this.icon, this.label, this.color);

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 14, color: color),
        const SizedBox(width: 5),
        Text(label,
            style: TextStyle(
                color: color, fontSize: 13, fontWeight: FontWeight.w600)),
      ]),
    );
  }
}

class _ResultRow extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  const _ResultRow(this.icon, this.label, this.color);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(children: [
        Icon(icon, size: 16, color: color),
        const SizedBox(width: 8),
        Text(label,
            style: TextStyle(fontSize: 14, color: color.withValues(alpha: 0.9))),
      ]),
    );
  }
}

class _PreviewTable extends StatelessWidget {
  final List<_ValidatedRow> rows;
  final bool isMembers;
  const _PreviewTable({required this.rows, required this.isMembers});

  @override
  Widget build(BuildContext context) {
    final cols = isMembers
        ? ['name', 'phone', 'plan_fee', 'membership_expiry_date']
        : ['name', 'phone', 'email'];

    return Container(
      decoration: BoxDecoration(
        border: Border.all(color: Colors.grey.shade300),
        borderRadius: BorderRadius.circular(8),
      ),
      clipBehavior: Clip.antiAlias,
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: DataTable(
          headingRowHeight: 36,
          dataRowMinHeight: 32,
          dataRowMaxHeight: 32,
          horizontalMargin: 12,
          columnSpacing: 16,
          headingRowColor: WidgetStateProperty.all(Colors.grey.shade100),
          columns: cols
              .map((c) => DataColumn(
                    label: Text(
                      c.replaceAll('_', ' '),
                      style: const TextStyle(
                          fontWeight: FontWeight.bold, fontSize: 12),
                    ),
                  ))
              .toList(),
          rows: rows
              .map((r) => DataRow(
                    cells: cols
                        .map((c) => DataCell(Text(
                              r.raw[c] ?? '',
                              style: const TextStyle(fontSize: 12),
                              overflow: TextOverflow.ellipsis,
                            )))
                        .toList(),
                  ))
              .toList(),
        ),
      ),
    );
  }
}
