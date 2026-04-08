import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../services/api_service.dart';
import '../models/models.dart';

class AttendanceScreen extends StatefulWidget {
  const AttendanceScreen({super.key});

  @override
  State<AttendanceScreen> createState() => _AttendanceScreenState();
}

class _AttendanceScreenState extends State<AttendanceScreen> {
  late Future<AttendanceResponse> attendanceFuture;

  @override
  void initState() {
    super.initState();
    attendanceFuture = ApiService().getAttendance();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Attendance')),
      body: FutureBuilder<AttendanceResponse>(
        future: attendanceFuture,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }

          if (snapshot.hasError) {
            final err = snapshot.error.toString().toLowerCase();
            if (err.contains('session') || err.contains('unauthorized') || err.contains('token') || err.contains('401')) {
              WidgetsBinding.instance.addPostFrameCallback((_) => context.go('/login'));
              return const Center(child: CircularProgressIndicator());
            }
            return Center(child: Text('Error: ${snapshot.error}'));
          }

          final attendance = snapshot.data?.attendance ?? [];

          return Column(
            children: [
              Padding(
                padding: const EdgeInsets.all(16),
                child: Card(
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Recent Check-ins', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold)),
                        const SizedBox(height: 8),
                        Text('${attendance.length} total check-ins this month', style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.grey[600])),
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
                    ],
                  ),
                )
                    : ListView.builder(
                  itemCount: attendance.length,
                  padding: const EdgeInsets.all(8),
                  itemBuilder: (context, index) {
                    final record = attendance[index];
                    return Card(
                      margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      child: ListTile(
                        leading: CircleAvatar(
                          backgroundColor: Colors.green.withOpacity(0.2),
                          child: const Icon(Icons.check_circle, color: Colors.green),
                        ),
                        title: Text('Member ID: ${record.memberId}', style: const TextStyle(fontWeight: FontWeight.bold)),
                        subtitle: Text('${record.visitDate.toString().split(' ')[0]} at ${record.checkInTime ?? 'No time'}'),
                        trailing: const Icon(Icons.arrow_forward_ios, size: 16),
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
        onPressed: () => _showMarkAttendanceDialog(context),
        child: const Icon(Icons.add),
      ),
    );
  }

  void _showMarkAttendanceDialog(BuildContext context) {
    final memberIdController = TextEditingController();
    DateTime selectedDate = DateTime.now();
    TimeOfDay selectedTime = TimeOfDay.now();

    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Mark Attendance'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: memberIdController,
                decoration: const InputDecoration(labelText: 'Member ID'),
              ),
              const SizedBox(height: 16),
              ListTile(
                title: const Text('Date'),
                subtitle: Text(selectedDate.toString().split(' ')[0]),
                trailing: const Icon(Icons.calendar_today),
                onTap: () async {
                  final date = await showDatePicker(
                    context: context,
                    initialDate: selectedDate,
                    firstDate: DateTime.now().subtract(const Duration(days: 365)),
                    lastDate: DateTime.now(),
                  );
                  if (date != null) {
                    selectedDate = date;
                  }
                },
              ),
              const SizedBox(height: 16),
              ListTile(
                title: const Text('Check-in Time'),
                subtitle: Text('${selectedTime.hour}:${selectedTime.minute.toString().padLeft(2, '0')}'),
                trailing: const Icon(Icons.access_time),
                onTap: () async {
                  final time = await showTimePicker(
                    context: context,
                    initialTime: selectedTime,
                  );
                  if (time != null) {
                    selectedTime = time;
                  }
                },
              ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () async {
              try {
                await ApiService().markAttendance(
                  memberId: memberIdController.text,
                  visitDate: selectedDate.toString().split(' ')[0],
                  checkInTime: '${selectedTime.hour}:${selectedTime.minute.toString().padLeft(2, '0')}',
                );
                if (mounted) {
                  Navigator.pop(context);
                  setState(() { attendanceFuture = ApiService().getAttendance(); });
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Attendance marked')),
                  );
                }
              } catch (e) {
                if (mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: $e')));
                }
              }
            },
            child: const Text('Mark'),
          ),
        ],
      ),
    );
  }
}
