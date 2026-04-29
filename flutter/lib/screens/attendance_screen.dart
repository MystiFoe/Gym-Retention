import 'package:flutter/material.dart';
import '../services/api_service.dart';
import '../models/models.dart';

class AttendanceScreen extends StatefulWidget {
  const AttendanceScreen({super.key});

  @override
  State<AttendanceScreen> createState() => _AttendanceScreenState();
}

class _AttendanceScreenState extends State<AttendanceScreen> {
  late Future<_AttendancePageData> _dataFuture;

  @override
  void initState() {
    super.initState();
    _dataFuture = _loadData();
  }

  Future<_AttendancePageData> _loadData() async {
    final results = await Future.wait([
      ApiService().getAttendance(),
      ApiService().getCustomers(),
    ]);
    return _AttendancePageData(
      attendance: (results[0] as AttendanceResponse).attendance,
      customers:  (results[1] as CustomersResponse).customers,
    );
  }

  void _refresh() => setState(() => _dataFuture = _loadData());

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Attendance')),
      body: FutureBuilder<_AttendancePageData>(
        future: _dataFuture,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(Icons.error_outline, size: 48, color: Colors.red),
                  const SizedBox(height: 12),
                  Text('Error: ${snapshot.error}', textAlign: TextAlign.center),
                  const SizedBox(height: 16),
                  ElevatedButton(onPressed: _refresh, child: const Text('Retry')),
                ],
              ),
            );
          }

          final data       = snapshot.data!;
          final attendance = data.attendance;
          final memberMap  = {for (final m in data.customers) m.id: m.name};

          return Column(
            children: [
              Padding(
                padding: const EdgeInsets.all(16),
                child: Card(
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Row(
                      children: [
                        const Icon(Icons.check_circle, color: Colors.green, size: 32),
                        const SizedBox(width: 12),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Recent Check-ins',
                              style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold),
                            ),
                            Text(
                              '${attendance.length} total check-ins',
                              style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.grey[600]),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              Expanded(
                child: attendance.isEmpty
                    ? Center(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(Icons.check_circle_outline, size: 64, color: Colors.grey[300]),
                            const SizedBox(height: 16),
                            Text('No check-ins yet', style: Theme.of(context).textTheme.titleMedium),
                            const SizedBox(height: 8),
                            Text('Tap + to mark attendance', style: TextStyle(color: Colors.grey[500])),
                          ],
                        ),
                      )
                    : ListView.builder(
                        itemCount: attendance.length,
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                        itemBuilder: (context, index) {
                          final record     = attendance[index];
                          final memberName = memberMap[record.customerId] ?? 'Unknown Customer';
                          final dateStr    = record.visitDate.toString().split(' ')[0];
                          final timeStr    = record.checkInTime ?? '—';
                          return Card(
                            margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                            child: ListTile(
                              leading: CircleAvatar(
                                backgroundColor: Colors.green.withValues(alpha: 0.15),
                                child: const Icon(Icons.check_circle, color: Colors.green),
                              ),
                              title: Text(memberName, style: const TextStyle(fontWeight: FontWeight.bold)),
                              subtitle: Text('$dateStr  •  $timeStr'),
                            ),
                          );
                        },
                      ),
              ),
            ],
          );
        },
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () async {
          final data = await _dataFuture;
          if (!context.mounted) return;
          _showMarkAttendanceDialog(context, data.customers);
        },
        child: const Icon(Icons.add),
      ),
    );
  }

  void _showMarkAttendanceDialog(BuildContext context, List<Customer> members) {
    Customer?  selectedMember;
    DateTime selectedDate = DateTime.now();
    TimeOfDay selectedTime = TimeOfDay.now();

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: const Text('Mark Attendance'),
          content: SizedBox(
            width: MediaQuery.sizeOf(context).width * 0.9,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Customer picker
                  DropdownButtonFormField<Customer>(
                    initialValue: selectedMember,
                    decoration: const InputDecoration(
                      labelText: 'Select Customer *',
                      prefixIcon: Icon(Icons.person),
                    ),
                    items: members.map((m) => DropdownMenuItem(
                      value: m,
                      child: Text(m.name),
                    )).toList(),
                    onChanged: (m) => setDialogState(() => selectedMember = m),
                    validator: (_) => selectedMember == null ? 'Please select a customer' : null,
                  ),
                  const SizedBox(height: 16),

                  // Date picker
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.calendar_today, color: Color(0xFF2196F3)),
                    title: const Text('Date'),
                    subtitle: Text(selectedDate.toString().split(' ')[0]),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () async {
                      final date = await showDatePicker(
                        context: ctx,
                        initialDate: selectedDate,
                        firstDate: DateTime.now().subtract(const Duration(days: 365)),
                        lastDate: DateTime.now(),
                      );
                      if (date != null) setDialogState(() => selectedDate = date);
                    },
                  ),
                  const Divider(height: 1),

                  // Time picker
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.access_time, color: Color(0xFF2196F3)),
                    title: const Text('Check-in Time'),
                    subtitle: Text(selectedTime.format(ctx)),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () async {
                      final time = await showTimePicker(
                        context: ctx,
                        initialTime: selectedTime,
                      );
                      if (time != null) setDialogState(() => selectedTime = time);
                    },
                  ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('Cancel'),
            ),
            ElevatedButton(
              onPressed: selectedMember == null
                  ? null
                  : () async {
                      final messenger = ScaffoldMessenger.of(context);
                      try {
                        final h = selectedTime.hour.toString().padLeft(2, '0');
                        final m = selectedTime.minute.toString().padLeft(2, '0');
                        await ApiService().markAttendance(
                          customerId:    selectedMember!.id,
                          visitDate:   selectedDate.toString().split(' ')[0],
                          checkInTime: '$h:$m',
                        );
                        if (!ctx.mounted) return;
                        Navigator.pop(ctx);
                        _refresh();
                        messenger.showSnackBar(
                          const SnackBar(content: Text('Attendance marked successfully')),
                        );
                      } catch (e) {
                        if (!ctx.mounted) return;
                        messenger.showSnackBar(
                          SnackBar(content: Text(e.toString().replaceFirst('Exception: ', ''))),
                        );
                      }
                    },
              child: const Text('Mark'),
            ),
          ],
        ),
      ),
    );
  }
}

class _AttendancePageData {
  final List<AttendanceRecord> attendance;
  final List<Customer>         customers;
  const _AttendancePageData({required this.attendance, required this.customers});
}
