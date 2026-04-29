import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:gym_fitness_app/utils/appui_helper.dart';
import '../services/api_service.dart';
import '../models/models.dart';

class TasksScreen extends StatefulWidget {
  final int refreshTrigger;
  const TasksScreen({super.key, this.refreshTrigger = 0});

  @override
  State<TasksScreen> createState() => _TasksScreenState();
}

class _TasksScreenState extends State<TasksScreen> {
  // ── Infinite scroll state ────────────────────────────────────────────────
  final ScrollController _scrollController = ScrollController();
  final List<Task> _tasks = [];
  int _currentPage = 1;
  int _totalPages = 1;
  bool _isLoading = false;
  bool _isLoadingMore = false;
  String? _error;
  String _selectedStatus = 'pending';

  // Kept for dialog dropdowns — load all at once
  late Future<CustomersResponse> membersFuture;
  late Future<StaffResponse> trainersFuture;

  @override
  void initState() {
    super.initState();
    membersFuture = ApiService().getCustomers(limit: 100);
    trainersFuture = ApiService().getStaff(limit: 100);
    _scrollController.addListener(_onScroll);
    _loadTasks(refresh: true);
  }

  @override
  void didUpdateWidget(TasksScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.refreshTrigger != oldWidget.refreshTrigger) {
      membersFuture  = ApiService().getCustomers(limit: 100);
      trainersFuture = ApiService().getStaff(limit: 100);
      _loadTasks(refresh: true);
    }
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_scrollController.position.pixels >=
        _scrollController.position.maxScrollExtent - 200) {
      if (!_isLoading && !_isLoadingMore && _currentPage <= _totalPages) {
        _loadTasks();
      }
    }
  }

  Future<void> _loadTasks({bool refresh = false}) async {
    if (!refresh && (_isLoading || _isLoadingMore)) return;
    if (!refresh && _currentPage > _totalPages) return;

    setState(() {
      if (refresh) {
        _isLoading = true;
        _tasks.clear();
        _currentPage = 1;
        _totalPages = 1;
        _error = null;
      } else {
        _isLoadingMore = true;
      }
    });

    try {
      final response = await ApiService().getTasks(
        status: _selectedStatus,
        page: _currentPage,
      );
      if (mounted) {
        setState(() {
          _tasks.addAll(response.tasks);
          _totalPages = response.pages;
          _currentPage++;
          _isLoading = false;
          _isLoadingMore = false;
          _error = null;
        });
      }
    } catch (e) {
      final errStr = e.toString().toLowerCase();
      if (mounted) {
        if (errStr.contains('session') || errStr.contains('unauthorized') ||
            errStr.contains('token') || errStr.contains('401')) {
          WidgetsBinding.instance
              .addPostFrameCallback((_) => context.push('/login'));
          return;
        }
        setState(() {
          _isLoading = false;
          _isLoadingMore = false;
          _error = e.toString();
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Tasks')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  _filterChip('pending', 'Pending', Colors.orange),
                  _filterChip('in_progress', 'In Progress', Colors.blue),
                  _filterChip('completed', 'Completed', Colors.green),
                ],
              ),
            ),
          ),
          Expanded(child: _buildTaskList()),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        heroTag: 'task_fab',
        onPressed: () => _showCreateTaskDialog(context),
        icon: const Icon(Icons.add),
        label: const Text('New Task'),
      ),
    );
  }

  Widget _buildTaskList() {
    if (_isLoading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, size: 48, color: Colors.red),
            const SizedBox(height: 12),
            Text('Error: $_error'),
            const SizedBox(height: 12),
            ElevatedButton(
              onPressed: () => _loadTasks(refresh: true),
              child: const Text('Retry'),
            ),
          ],
        ),
      );
    }
    if (_tasks.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.assignment_outlined, size: 64, color: Colors.grey[300]),
            const SizedBox(height: 16),
            Text(
              'No ${_selectedStatus.replaceAll('_', ' ')} tasks',
              style: Theme.of(context).textTheme.titleMedium,
            ),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: () => _loadTasks(refresh: true),
      child: ListView.builder(
        controller: _scrollController,
        itemCount: _tasks.length + (_isLoadingMore ? 1 : 0),
        padding: const EdgeInsets.all(8),
        itemBuilder: (context, index) {
          if (index == _tasks.length) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(16),
                child: CircularProgressIndicator(),
              ),
            );
          }
          return _TaskCard(
            task: _tasks[index],
            onReload: () => _loadTasks(refresh: true),
          );
        },
      ),
    );
  }

  Widget _filterChip(String status, String label, Color color) {
    final selected = _selectedStatus == status;
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
        onSelected: (_) {
          _selectedStatus = status;
          _loadTasks(refresh: true);
        },
      ),
    );
  }

  void _showCreateTaskDialog(BuildContext context) {
    String? selectedMemberId;
    String selectedTaskType = 'call';
    final notesController = TextEditingController();
    List<Customer> allMembers = [];
    List<Staff> allTrainers = [];

    // Always fetch fresh data when dialog opens — never use cached initState futures
    final freshData = Future.wait([
      ApiService().getCustomers(limit: 200),
      ApiService().getStaff(limit: 100),
    ]);

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(

          title: const Text('Create Task'),
          content: SizedBox(
            width: MediaQuery.of(context).size.width * 0.9,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  FutureBuilder<List<dynamic>>(
                    future: freshData,
                    builder: (context, snapshot) {
                      if (snapshot.data != null) {
                        allMembers = (snapshot.data![0] as CustomersResponse).customers;
                        allTrainers = (snapshot.data![1] as StaffResponse).staff;
                      }
                      final members = (snapshot.data?[0] as CustomersResponse?)?.customers ?? [];
                      return DropdownButtonFormField<String>(
                        decoration: const InputDecoration(
                            labelText: 'Select Customer *',
                            prefixIcon: Icon(Icons.person)),
                        initialValue: selectedMemberId,
                        items: members
                            .map((m) => DropdownMenuItem<String>(
                                  value: m.id,
                                  child: Text('${m.name} (${m.phone})'),
                                ))
                            .toList(),
                        onChanged: (v) {
                          setDialogState(() {
                            selectedMemberId = v;
                          });
                        },
                      );
                    },
                  ),
                  const SizedBox(height: 16),
                  DropdownButtonFormField<String>(
                    decoration: const InputDecoration(
                        labelText: 'Task Type',
                        prefixIcon: Icon(Icons.assignment)),
                    initialValue: selectedTaskType,
                    items: const [
                      DropdownMenuItem(value: 'call', child: Text('Call')),
                      DropdownMenuItem(value: 'renewal', child: Text('Renew Plan')),
                      DropdownMenuItem(value: 'check_in', child: Text('Check-In')),
                    ],
                    onChanged: (v) => setDialogState(() => selectedTaskType = v ?? 'call'),
                  ),
                  const SizedBox(height: 16),
                  TextField(
                    controller: notesController,
                    maxLines: 3,
                    maxLength: 500,
                    decoration: const InputDecoration(
                        labelText: 'Notes (optional)', border: OutlineInputBorder()),
                  ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
            ElevatedButton(
              onPressed: () async {
                if (selectedMemberId == null) {
                  AppUiHelper().showModernSnackBar(context, message: "Please select a customer");

                  // ScaffoldMessenger.of(ctx).showSnackBar(
                  //     const SnackBar(content: Text('Please select a member')));
                  return;
                }
                final nav = Navigator.of(ctx);
                try {
                  await ApiService().createTask(
                    customerId: selectedMemberId!,
                    taskType: selectedTaskType,
                    notes: notesController.text.isEmpty ? null : notesController.text,
                  );
                  // Look up trainer name from member's assignedTrainerId
                  final member = allMembers.where((m) => m.id == selectedMemberId).firstOrNull;
                  final trainerId = member?.assignedStaffId;
                  final trainerName = trainerId != null
                      ? allTrainers.where((t) => t.id == trainerId).firstOrNull?.name
                      : null;
                  nav.pop();
                  _loadTasks(refresh: true);
                  if (!context.mounted) return;
                  AppUiHelper().showModernSnackBar(context, message: trainerName != null ? 'Task assigned to $trainerName' : 'Task created');

                  // messenger.showSnackBar(SnackBar(
                  //   content: Text(trainerName != null ? 'Task assigned to $trainerName' : 'Task created'),
                  //   backgroundColor: Colors.green,
                  // ));
                } catch (e) {
                  if (!context.mounted) return;
                  AppUiHelper().showModernSnackBar(context, message: e.toString(), isError: true);
                }
              },
              child: const Text('Create'),
            ),
          ],
        ),
      ),
    );
  }
}

// ============================================================================
// TASK CARD
// ============================================================================

class _TaskCard extends StatelessWidget {
  final Task task;
  final VoidCallback onReload;

  const _TaskCard({required this.task, required this.onReload});

  @override
  Widget build(BuildContext context) {
    final isCompleted = task.status == 'completed';

    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: ListTile(
        leading: Icon(_getTaskIcon(task.taskType),
            color: _getTaskColor(task.taskType)),
        title: Text(task.customerName ?? 'Customer',
            style: const TextStyle(fontWeight: FontWeight.bold)),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${_taskTypeLabel(task.taskType)} • ${task.customerPhone ?? ""}'),
            if (task.staffName != null)
              Text('Staff: ${task.staffName}',
                  style: TextStyle(fontSize: 12, color: Colors.grey[600])),
            if (task.notes != null && task.notes!.isNotEmpty)
              Text(task.notes!,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.grey[500])),
          ],
        ),
        isThreeLine: task.staffName != null ||
            (task.notes != null && task.notes!.isNotEmpty),
        trailing: isCompleted
            ? _OutcomeBadge(outcome: task.outcome)
            : _StatusBadge(status: task.status),
        onTap: () => _showTaskDetails(context),
      ),
    );
  }

  void _showTaskDetails(BuildContext context) {
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
      builder: (ctx) => SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Task Details',
                style: Theme.of(ctx)
                    .textTheme
                    .titleLarge
                    ?.copyWith(fontWeight: FontWeight.bold)),
            const Divider(height: 24),
            _row('Customer', task.customerName ?? task.customerId),
            _row('Phone', task.customerPhone ?? '-'),
            _row('Type', _taskTypeLabel(task.taskType)),
            _row('Status', task.status.replaceAll('_', ' ').toUpperCase()),
            if (task.staffName != null) _row('Staff', task.staffName!),
            if (task.outcome != null) _row('Outcome', _outcomeLabel(task.outcome!)),
            _row('Created', task.createdAt.toString().split('.')[0]),
            if (task.completedAt != null)
              _row('Completed', task.completedAt.toString().split('.')[0]),
            if (task.notes != null && task.notes!.isNotEmpty)
              _row('Notes', task.notes!),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.blue[50],
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Row(
                children: [
                  Icon(Icons.info_outline, size: 16, color: Colors.blue),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Tasks can only be completed by the assigned staff.',
                      style: TextStyle(fontSize: 12, color: Colors.blue),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _row(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label,
              style: const TextStyle(fontWeight: FontWeight.w600, color: Colors.grey)),
          Expanded(
              child: Text(value,
                  textAlign: TextAlign.end,
                  style: const TextStyle(fontWeight: FontWeight.w500))),
        ],
      ),
    );
  }

  String _taskTypeLabel(String type) {
    switch (type) {
      case 'call': return 'Call';
      case 'renewal': return 'Renew Plan';
      case 'check_in': return 'Check-In';
      default: return type.toUpperCase();
    }
  }

  String _outcomeLabel(String outcome) {
    switch (outcome) {
      case 'called': return 'Called';
      case 'not_reachable': return 'Not Reachable';
      case 'coming_tomorrow': return 'Coming Tomorrow';
      case 'renewed': return 'Plan Renewed';
      case 'no_action': return 'No Action';
      default: return outcome;
    }
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
// OUTCOME BADGE — shown on completed tasks
// ============================================================================

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
          style: TextStyle(
              color: color, fontSize: 11, fontWeight: FontWeight.bold)),
    );
  }

  String _label(String o) {
    switch (o) {
      case 'called': return 'Called';
      case 'not_reachable': return 'Not Reachable';
      case 'coming_tomorrow': return 'Coming Tomorrow';
      case 'renewed': return 'Plan Renewed ✓';
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

class _StatusBadge extends StatelessWidget {
  final String status;
  const _StatusBadge({required this.status});

  @override
  Widget build(BuildContext context) {
    final color = status == 'in_progress' ? Colors.blue : Colors.grey;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Text(
        status.replaceAll('_', ' ').toUpperCase(),
        style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.bold),
      ),
    );
  }
}
