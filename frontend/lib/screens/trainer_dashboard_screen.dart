import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../services/api_service.dart';
import '../models/models.dart';

class TrainerDashboardScreen extends StatefulWidget {
  const TrainerDashboardScreen({super.key});

  @override
  State<TrainerDashboardScreen> createState() => _TrainerDashboardScreenState();
}

class _TrainerDashboardScreenState extends State<TrainerDashboardScreen> {
  int _selectedTab = 0;
  String? trainerId;
  late Future<TasksResponse> tasksFuture;
  late Future<MembersResponse> membersFuture;
  final Set<String> _todayMarkedIds = {};
  String _taskStatusFilter = 'pending';

  @override
  void initState() {
    super.initState();
    tasksFuture = Future.value(TasksResponse(tasks: []));
    membersFuture = Future.value(MembersResponse(members: [], total: 0, page: 1, pages: 1));
    _initTrainer();
  }

  Future<void> _initTrainer() async {
    try {
      final trainer = await ApiService().getMyTrainerProfile();
      if (mounted) {
        setState(() {
          trainerId = trainer.id;
          tasksFuture = ApiService().getTasks(status: _taskStatusFilter, trainerId: trainer.id);
          membersFuture = ApiService().getMembers(limit: 100);
        });
        await _loadTodayAttendance();
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          tasksFuture = ApiService().getTasks(status: _taskStatusFilter);
          membersFuture = ApiService().getMembers(limit: 100);
        });
        await _loadTodayAttendance();
      }
    }
  }

  Future<void> _loadTodayAttendance() async {
    try {
      final today = DateTime.now();
      final todayStr = '${today.year}-${today.month.toString().padLeft(2, '0')}-${today.day.toString().padLeft(2, '0')}';
      // Pass today's date so backend only returns today's records (plain date string, no timezone issues)
      final attendance = await ApiService().getAttendance(date: todayStr);
      if (mounted) {
        setState(() {
          _todayMarkedIds.clear();
          for (final record in attendance.attendance) {
            _todayMarkedIds.add(record.memberId);
          }
        });
      }
    } catch (_) {}
  }

  void _reloadTasks() {
    setState(() {
      tasksFuture = ApiService().getTasks(status: _taskStatusFilter, trainerId: trainerId);
    });
  }

  void _setTaskFilter(String status) {
    setState(() {
      _taskStatusFilter = status;
      tasksFuture = ApiService().getTasks(status: status, trainerId: trainerId);
    });
  }

  void _reloadMembers() {
    setState(() {
      membersFuture = ApiService().getMembers(limit: 100);
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: FutureBuilder<TasksResponse>(
          future: tasksFuture,
          builder: (context, snapshot) {
            final pending = snapshot.data?.tasks
                    .where((t) => t.status == 'pending')
                    .length ??
                0;
            if (pending == 0) return const Text('Trainer Portal');
            return Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text('Trainer Portal'),
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(
                    color: Colors.red,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    '$pending',
                    style: const TextStyle(
                        color: Colors.white,
                        fontSize: 12,
                        fontWeight: FontWeight.bold),
                  ),
                ),
              ],
            );
          },
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: () async {
              await ApiService().logout();
              if (mounted) context.go('/login'); // ignore: use_build_context_synchronously
            },
          ),
        ],
      ),
      body: IndexedStack(
        index: _selectedTab,
        children: [
          _TasksTab(
            tasksFuture: tasksFuture,
            onReload: _reloadTasks,
            selectedStatus: _taskStatusFilter,
            onStatusChanged: _setTaskFilter,
          ),
          _MembersTab(
            membersFuture: membersFuture,
            onReload: _reloadMembers,
            todayMarkedIds: _todayMarkedIds,
            onAttendanceMarked: (memberId) {
              setState(() => _todayMarkedIds.add(memberId));
            },
          ),
        ],
      ),
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: _selectedTab,
        onTap: (index) => setState(() => _selectedTab = index),
        items: [
          BottomNavigationBarItem(
            icon: FutureBuilder<TasksResponse>(
              future: tasksFuture,
              builder: (context, snapshot) {
                final pending = snapshot.data?.tasks
                        .where((t) => t.status == 'pending')
                        .length ??
                    0;
                return Badge(
                  isLabelVisible: pending > 0,
                  label: Text('$pending'),
                  child: const Icon(Icons.assignment),
                );
              },
            ),
            label: 'My Tasks',
          ),
          const BottomNavigationBarItem(
            icon: Icon(Icons.people),
            label: 'My Members',
          ),
        ],
      ),
    );
  }
}

// ============================================================================
// TASKS TAB
// ============================================================================

class _TasksTab extends StatelessWidget {
  final Future<TasksResponse> tasksFuture;
  final VoidCallback onReload;
  final String selectedStatus;
  final void Function(String) onStatusChanged;

  const _TasksTab({
    required this.tasksFuture,
    required this.onReload,
    required this.selectedStatus,
    required this.onStatusChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                _filterChip('pending', 'Pending', Colors.orange),
                _filterChip('completed', 'Completed', Colors.green),
              ],
            ),
          ),
        ),
        Expanded(
          child: FutureBuilder<TasksResponse>(
            future: tasksFuture,
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
                return Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text('Error: ${snapshot.error}'),
                      const SizedBox(height: 12),
                      ElevatedButton(onPressed: onReload, child: const Text('Retry')),
                    ],
                  ),
                );
              }

              final tasks = snapshot.data?.tasks ?? [];

              if (tasks.isEmpty) {
                return Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(Icons.assignment_outlined, size: 64, color: Colors.grey[300]),
                      const SizedBox(height: 16),
                      Text('No ${selectedStatus.replaceAll('_', ' ')} tasks',
                          style: Theme.of(context).textTheme.titleMedium),
                    ],
                  ),
                );
              }

              return RefreshIndicator(
                onRefresh: () async => onReload(),
                child: ListView.builder(
                  itemCount: tasks.length,
                  padding: const EdgeInsets.all(8),
                  itemBuilder: (context, index) {
                    final task = tasks[index];
                    return _TaskCard(task: task, onCompleted: onReload);
                  },
                ),
              );
            },
          ),
        ),
      ],
    );
  }

  Widget _filterChip(String status, String label, Color color) {
    final selected = selectedStatus == status;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: FilterChip(
        label: Text(label,
            style: TextStyle(
                color: selected ? color : Colors.grey[700],
                fontWeight: selected ? FontWeight.bold : FontWeight.normal)),
        selected: selected,
        selectedColor: color.withValues(alpha: 0.15),
        checkmarkColor: color,
        side: BorderSide(color: selected ? color : Colors.grey[300]!),
        onSelected: (_) => onStatusChanged(status),
      ),
    );
  }
}

class _TaskCard extends StatelessWidget {
  final Task task;
  final VoidCallback onCompleted;

  const _TaskCard({required this.task, required this.onCompleted});

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: ListTile(
        leading: Icon(_getTaskIcon(task.taskType), color: _getTaskColor(task.taskType), size: 28),
        title: Text(task.memberName ?? 'Member',
            style: const TextStyle(fontWeight: FontWeight.bold)),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${task.taskType.toUpperCase()}${task.memberPhone != null ? " • ${task.memberPhone}" : ""}'),
            if (task.notes != null && task.notes!.isNotEmpty)
              Text(task.notes!, style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
        isThreeLine: task.notes != null && task.notes!.isNotEmpty,
        trailing: task.status == 'completed'
            ? _OutcomeBadge(outcome: task.outcome)
            : ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.blue,
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                ),
                onPressed: () => _showCompleteDialog(context, task),
                child: const Text('Complete', style: TextStyle(fontSize: 12)),
              ),
      ),
    );
  }

  void _showCompleteDialog(BuildContext context, Task task) {
    final noteController = TextEditingController();
    String selectedOutcome = 'called';

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: const Text('Complete Task'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Member: ${task.memberName ?? task.memberId}',
                    style: const TextStyle(fontWeight: FontWeight.bold)),
                Text('Type: ${task.taskType.toUpperCase()}'),
                const SizedBox(height: 16),
                DropdownButtonFormField<String>(
                  initialValue: selectedOutcome,
                  decoration: const InputDecoration(labelText: 'Outcome *'),
                  items: const [
                    DropdownMenuItem(value: 'called', child: Text('Called')),
                    DropdownMenuItem(value: 'not_reachable', child: Text('Not Reachable')),
                    DropdownMenuItem(value: 'coming_tomorrow', child: Text('Coming Tomorrow')),
                    DropdownMenuItem(value: 'renewed', child: Text('Renewed')),
                    DropdownMenuItem(value: 'no_action', child: Text('No Action')),
                  ],
                  onChanged: (v) => setDialogState(() => selectedOutcome = v ?? 'called'),
                ),
                const SizedBox(height: 16),
                TextField(
                  controller: noteController,
                  maxLines: 3,
                  decoration: const InputDecoration(labelText: 'Notes', border: OutlineInputBorder()),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
            ElevatedButton(
              onPressed: () async {
                final messenger = ScaffoldMessenger.of(context);
                final nav = Navigator.of(ctx);
                try {
                  await ApiService().completeTask(
                    taskId: task.id,
                    outcome: selectedOutcome,
                    notes: noteController.text.isEmpty ? null : noteController.text,
                  );
                  nav.pop();
                  onCompleted();
                  messenger.showSnackBar(
                      const SnackBar(content: Text('Task completed successfully')));
                } catch (e) {
                  messenger.showSnackBar(SnackBar(content: Text('Error: $e')));
                }
              },
              child: const Text('Complete'),
            ),
          ],
        ),
      ),
    );
  }

  IconData _getTaskIcon(String type) {
    switch (type) {
      case 'call': return Icons.phone;
      case 'renewal': return Icons.cached;
      case 'check_in': return Icons.check_circle;
      default: return Icons.assignment;
    }
  }

  Color _getTaskColor(String type) {
    switch (type) {
      case 'call': return Colors.blue;
      case 'renewal': return Colors.purple;
      case 'check_in': return Colors.green;
      default: return Colors.grey;
    }
  }
}

// ============================================================================
// MEMBERS TAB
// ============================================================================

class _MembersTab extends StatelessWidget {
  final Future<MembersResponse> membersFuture;
  final VoidCallback onReload;
  final Set<String> todayMarkedIds;
  final void Function(String memberId) onAttendanceMarked;

  const _MembersTab({
    required this.membersFuture,
    required this.onReload,
    required this.todayMarkedIds,
    required this.onAttendanceMarked,
  });

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<MembersResponse>(
      future: membersFuture,
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
          return Center(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text('Error: ${snapshot.error}'),
                const SizedBox(height: 12),
                ElevatedButton(onPressed: onReload, child: const Text('Retry')),
              ],
            ),
          );
        }

        final members = snapshot.data?.members ?? [];

        if (members.isEmpty) {
          return Center(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(Icons.people_outline, size: 64, color: Colors.grey[300]),
                const SizedBox(height: 16),
                Text('No members assigned to you',
                    style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 8),
                Text('Ask your gym owner to assign members',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.grey)),
              ],
            ),
          );
        }

        return RefreshIndicator(
          onRefresh: () async => onReload(),
          child: ListView.builder(
            itemCount: members.length,
            padding: const EdgeInsets.all(12),
            itemBuilder: (context, index) {
              final member = members[index];
              final statusColor = _statusColor(member.status);
              return Card(
                margin: const EdgeInsets.only(bottom: 10),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          CircleAvatar(
                            backgroundColor: statusColor.withValues(alpha: 0.15),
                            child: Text(member.name[0].toUpperCase(),
                                style: TextStyle(color: statusColor, fontWeight: FontWeight.bold)),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(member.name,
                                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
                                Text(member.phone,
                                    style: TextStyle(color: Colors.grey[600], fontSize: 13)),
                              ],
                            ),
                          ),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                            decoration: BoxDecoration(
                              color: statusColor.withValues(alpha: 0.1),
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: Text(
                              member.status.replaceAll('_', ' ').toUpperCase(),
                              style: TextStyle(fontSize: 10, color: statusColor, fontWeight: FontWeight.bold),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          Expanded(
                            child: _InfoChip(
                              icon: Icons.calendar_today,
                              label: 'Expires: ${_formatDate(member.membershipExpiryDate)}',
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: _InfoChip(
                              icon: Icons.fitness_center,
                              label: member.lastVisitDate != null
                                  ? 'Last: ${_formatDate(member.lastVisitDate!)}'
                                  : 'No visits yet',
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Builder(builder: (context) {
                        final alreadyMarked = todayMarkedIds.contains(member.id);
                        return SizedBox(
                          width: double.infinity,
                          child: ElevatedButton.icon(
                            style: ElevatedButton.styleFrom(
                              backgroundColor: alreadyMarked ? Colors.grey[400] : Colors.green,
                              foregroundColor: Colors.white,
                              padding: const EdgeInsets.symmetric(vertical: 8),
                            ),
                            icon: Icon(
                              alreadyMarked ? Icons.check_circle : Icons.check_circle_outline,
                              size: 18,
                            ),
                            label: Text(alreadyMarked ? 'Attendance Marked' : 'Mark Attendance Today'),
                            onPressed: alreadyMarked ? null : () => _markAttendance(context, member),
                          ),
                        );
                      }),
                    ],
                  ),
                ),
              );
            },
          ),
        );
      },
    );
  }

  void _markAttendance(BuildContext context, Member member) async {
    final messenger = ScaffoldMessenger.of(context);
    final today = DateTime.now();
    final dateStr = '${today.year}-${today.month.toString().padLeft(2, '0')}-${today.day.toString().padLeft(2, '0')}';
    try {
      await ApiService().markAttendance(
        memberId: member.id,
        visitDate: dateStr,
      );
      onAttendanceMarked(member.id);
      messenger.showSnackBar(
        SnackBar(content: Text('Attendance marked for ${member.name}')),
      );
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Error: $e')));
    }
  }

  Color _statusColor(String status) {
    switch (status) {
      case 'active':    return const Color(0xFF4CAF50);
      case 'at_risk':   return const Color(0xFFFF9800);
      case 'high_risk': return const Color(0xFFF44336);
      default:          return Colors.grey;
    }
  }

  String _formatDate(DateTime dt) {
    return '${dt.day.toString().padLeft(2, '0')}-${dt.month.toString().padLeft(2, '0')}-${dt.year}';
  }
}

class _OutcomeBadge extends StatelessWidget {
  final String? outcome;
  const _OutcomeBadge({this.outcome});

  @override
  Widget build(BuildContext context) {
    final label = _label(outcome ?? '');
    final color = _color(outcome ?? '');
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Text(label,
          style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.bold)),
    );
  }

  String _label(String o) {
    switch (o) {
      case 'called': return 'Called';
      case 'not_reachable': return 'Not Reachable';
      case 'coming_tomorrow': return 'Coming Tomorrow';
      case 'renewed': return 'Renewed ✓';
      case 'no_action': return 'No Action';
      default: return 'Completed';
    }
  }

  Color _color(String o) {
    switch (o) {
      case 'renewed': return Colors.green;
      case 'called': return Colors.blue;
      case 'coming_tomorrow': return Colors.teal;
      case 'not_reachable': return Colors.orange;
      case 'no_action': return Colors.grey;
      default: return Colors.blueGrey;
    }
  }
}

class _InfoChip extends StatelessWidget {
  final IconData icon;
  final String label;
  const _InfoChip({required this.icon, required this.label});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, size: 12, color: Colors.grey[500]),
        const SizedBox(width: 4),
        Expanded(
          child: Text(label,
              style: TextStyle(fontSize: 11, color: Colors.grey[600]),
              overflow: TextOverflow.ellipsis),
        ),
      ],
    );
  }
}

