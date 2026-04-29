import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';
import 'package:gym_fitness_app/utils/app_routes.dart';
import 'package:gym_fitness_app/utils/appui_helper.dart';
import '../services/api_service.dart';
import '../services/firebase_service.dart';
import '../models/models.dart';
import 'profile_screen.dart';

class TrainerDashboardScreen extends StatefulWidget {
  const TrainerDashboardScreen({super.key});

  @override
  State<TrainerDashboardScreen> createState() => _TrainerDashboardScreenState();
}

class _TrainerDashboardScreenState extends State<TrainerDashboardScreen> {
  int _selectedTab = 0;
  DateTime? _lastBackPress;
  String? trainerId;
  String? _staffPhone;
  bool _phoneVerified = true;
  bool _verifyingPhone = false;
  final Set<String> _todayMarkedIds = {};
  int _pendingTaskCount = 0;

  @override
  void initState() {
    super.initState();
    _initTrainer();
  }

  Future<void> _initTrainer() async {
    try {
      final trainer = await ApiService().getMyStaffProfile();
      if (mounted) setState(() => trainerId = trainer.id);
    } catch (_) {}
    try {
      final profile = await ApiService().getProfile();
      if (mounted) {
        setState(() {
          _phoneVerified = profile.phoneVerified;
          _staffPhone = profile.phone;
        });
      }
    } catch (_) {}
    await _loadTodayAttendance();
  }

  Future<void> _verifyPhone() async {
    if (_staffPhone == null || _staffPhone!.isEmpty) {
      AppUiHelper().showModernSnackBar(context, message: 'No phone number on file. Update your profile first.', isError: true);
      return;
    }
    setState(() => _verifyingPhone = true);
    try {
      final phone = _staffPhone!.startsWith('+') ? _staffPhone! : '+91$_staffPhone';
      final result = await FirebaseService().sendOtp(phone);

      if (result.autoVerified && result.idToken != null) {
        await ApiService().verifyProfilePhone(result.idToken!);
        if (mounted) setState(() => _phoneVerified = true);
        if (mounted) AppUiHelper().showModernSnackBar(context, message: 'Phone verified successfully');
        return;
      }

      if (!mounted) return;
      final codeCtrl = TextEditingController();
      final confirmed = await showDialog<bool>(
        context: context,
        barrierDismissible: false,
        builder: (ctx) => AlertDialog(
          title: const Text('Verify Your Phone'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Enter the OTP sent to $phone'),
              const SizedBox(height: 16),
              TextField(
                controller: codeCtrl,
                keyboardType: TextInputType.number,
                maxLength: 6,
                autofocus: true,
                decoration: const InputDecoration(labelText: '6-digit OTP', counterText: ''),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            ElevatedButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Verify')),
          ],
        ),
      );
      if (confirmed != true || !mounted) return;
      final idToken = await FirebaseService().verifyOtp(
        verificationId: result.verificationId!,
        smsCode: codeCtrl.text.trim(),
      );
      await ApiService().verifyProfilePhone(idToken);
      if (mounted) setState(() => _phoneVerified = true);
      if (mounted) AppUiHelper().showModernSnackBar(context, message: 'Phone verified successfully');
    } catch (e) {
      if (mounted) AppUiHelper().showModernSnackBar(context, message: e.toString(), isError: true);
    } finally {
      if (mounted) setState(() => _verifyingPhone = false);
    }
  }

  Future<void> _loadTodayAttendance() async {
    try {
      final today = DateTime.now();
      final todayStr = '${today.year}-${today.month.toString().padLeft(2, '0')}-${today.day.toString().padLeft(2, '0')}';
      final attendance = await ApiService().getAttendance(date: todayStr);
      if (mounted) {
        setState(() {
          _todayMarkedIds.clear();
          for (final record in attendance.attendance) {
            _todayMarkedIds.add(record.customerId);
          }
        });
      }
    } catch (_) {}
  }

  Future<void> _onBackPressed() async {
    if (_selectedTab != 0) {
      setState(() => _selectedTab = 0);
      return;
    }
    final now = DateTime.now();
    if (_lastBackPress != null &&
        now.difference(_lastBackPress!) < const Duration(seconds: 2)) {
      SystemNavigator.pop();
      return;
    }
    _lastBackPress = now;
    final exit = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Exit App'),
        content: const Text('Do you want to quit Recurva?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('No')),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Yes', style: TextStyle(color: Colors.red))),
        ],
      ),
    );
    if (exit == true) SystemNavigator.pop();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (!didPop) await _onBackPressed();
      },
      child: Scaffold(
      appBar: AppBar(
        title: _pendingTaskCount == 0
            ? const Text('Staff Portal')
            : Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('Staff Portal'),
                  const SizedBox(width: 8),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    decoration: BoxDecoration(
                      color: Colors.red,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Text(
                      '$_pendingTaskCount',
                      style: const TextStyle(
                          color: Colors.white,
                          fontSize: 12,
                          fontWeight: FontWeight.bold),
                    ),
                  ),
                ],
              ),
        actions: [
          IconButton(
            icon: const CircleAvatar(
              radius: 16,
              backgroundColor: Color(0xFF1976D2),
              child: Icon(Icons.person, size: 18, color: Colors.white),
            ),
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(builder: (_) => const ProfileScreen()),
            ).then((_) => _initTrainer()),
          ),
          const SizedBox(width: 4),
        ],
      ),
      body: Column(
        children: [
          // ── Phone verification banner ──────────────────────────────────
          if (!_phoneVerified)
            Material(
              color: Colors.red.shade50,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                child: Row(
                  children: [
                    Icon(Icons.warning_amber_rounded, color: Colors.red.shade700, size: 20),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'Phone not verified. Verify to enable all features.',
                        style: TextStyle(color: Colors.red.shade800, fontSize: 13),
                      ),
                    ),
                    _verifyingPhone
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                        : TextButton(
                            onPressed: _verifyPhone,
                            style: TextButton.styleFrom(
                              foregroundColor: Colors.red.shade700,
                              padding: const EdgeInsets.symmetric(horizontal: 8),
                            ),
                            child: const Text('Verify Now', style: TextStyle(fontWeight: FontWeight.bold)),
                          ),
                  ],
                ),
              ),
            ),
          // ── Main content ────────────────────────────────────────────────
          Expanded(
            child: IndexedStack(
              index: _selectedTab,
              children: [
                _TasksTab(
                  staffId: trainerId,
                  onPendingCountChanged: (count) =>
                      setState(() => _pendingTaskCount = count),
                ),
                _MembersTab(
                  staffId: trainerId,
                  todayMarkedIds: _todayMarkedIds,
                  onAttendanceMarked: (memberId) {
                    setState(() => _todayMarkedIds.add(memberId));
                  },
                ),
              ],
            ),
          ),
        ],
      ),
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: _selectedTab,
        onTap: (index) => setState(() => _selectedTab = index),
        items: [
          BottomNavigationBarItem(
            icon: Badge(
              isLabelVisible: _pendingTaskCount > 0,
              label: Text('$_pendingTaskCount'),
              child: const Icon(Icons.assignment),
            ),
            label: 'My Tasks',
          ),
          const BottomNavigationBarItem(
            icon: Icon(Icons.people),
            label: 'My Customers',
          ),
        ],
      ),
    ),   // Scaffold
    );   // PopScope
  }
}

// ============================================================================
// TASKS TAB
// ============================================================================

class _TasksTab extends StatefulWidget {
  final String? staffId;
  final void Function(int) onPendingCountChanged;

  const _TasksTab({
    required this.staffId,
    required this.onPendingCountChanged,
  });

  @override
  State<_TasksTab> createState() => _TasksTabState();
}

class _TasksTabState extends State<_TasksTab> {
  final List<Task> _tasks = [];
  int _page = 1;
  bool _hasMore = true;
  bool _loading = false;
  bool _initialLoad = true;
  String _status = 'pending';
  String? _error;
  final ScrollController _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    _load();
  }

  @override
  void didUpdateWidget(_TasksTab old) {
    super.didUpdateWidget(old);
    if (old.staffId != widget.staffId) {
      _reload();
    }
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_scroll.position.pixels >= _scroll.position.maxScrollExtent - 200) {
      _load();
    }
  }

  void _reload() {
    setState(() {
      _tasks.clear();
      _page = 1;
      _hasMore = true;
      _error = null;
      _initialLoad = true;
    });
    _load();
  }

  Future<void> _load() async {
    if (_loading || !_hasMore) return;
    setState(() => _loading = true);
    try {
      final resp = await ApiService().getTasks(
        page: _page,
        limit: 20,
        status: _status,
        staffId: widget.staffId,
      );
      if (!mounted) return;
      setState(() {
        _tasks.addAll(resp.tasks);
        _page++;
        _hasMore = _page <= resp.pages;
        _initialLoad = false;
        _error = null;
      });
      // Update pending badge count (only for pending filter)
      if (_status == 'pending') {
        widget.onPendingCountChanged(resp.total);
      }
    } catch (e) {
      if (!mounted) return;
      final err = e.toString().toLowerCase();
      if (err.contains('session') || err.contains('unauthorized') || err.contains('token') || err.contains('401')) {
        WidgetsBinding.instance.addPostFrameCallback((_) => context.go('/login'));
        return;
      }
      setState(() {
        _error = e.toString();
        _initialLoad = false;
      });
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

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
        Expanded(child: _buildList()),
      ],
    );
  }

  Widget _buildList() {
    if (_initialLoad && _loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null && _tasks.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text('Error: $_error'),
            const SizedBox(height: 12),
            ElevatedButton(onPressed: _reload, child: const Text('Retry')),
          ],
        ),
      );
    }
    if (!_loading && _tasks.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.assignment_outlined, size: 64, color: Colors.grey[300]),
            const SizedBox(height: 16),
            Text('No ${_status.replaceAll('_', ' ')} tasks',
                style: Theme.of(context).textTheme.titleMedium),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: () async => _reload(),
      child: ListView.builder(
        controller: _scroll,
        padding: const EdgeInsets.all(8),
        itemCount: _tasks.length + (_hasMore ? 1 : 0),
        itemBuilder: (context, index) {
          if (index == _tasks.length) {
            return const Padding(
              padding: EdgeInsets.all(16),
              child: Center(child: CircularProgressIndicator()),
            );
          }
          return _TaskCard(task: _tasks[index], onCompleted: _reload);
        },
      ),
    );
  }

  Widget _filterChip(String status, String label, Color color) {
    final selected = _status == status;
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
          setState(() => _status = status);
          _reload();
        },
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
        title: Text(task.customerName ?? 'Customer',
            style: const TextStyle(fontWeight: FontWeight.bold)),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${task.taskType.toUpperCase()}${task.customerPhone != null ? " • ${task.customerPhone}" : ""}'),
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
                Text('Customer: ${task.customerName ?? task.customerId}',
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
                    DropdownMenuItem(value: 'renewed', child: Text('Plan Renewed')),
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
                final nav = Navigator.of(ctx);
                try {
                  await ApiService().completeTask(
                    taskId: task.id,
                    outcome: selectedOutcome,
                    notes: noteController.text.isEmpty ? null : noteController.text,
                  );
                  nav.pop();
                  onCompleted();
                  if (!context.mounted) return;
                  AppUiHelper().showModernSnackBar(context, message: "Task completed successfully");
                } catch (e) {
                  if (!context.mounted) return;
                  AppUiHelper().showModernSnackBar(context, message: e.toString(), isError: true);
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

class _MembersTab extends StatefulWidget {
  final String? staffId;
  final Set<String> todayMarkedIds;
  final void Function(String memberId) onAttendanceMarked;

  const _MembersTab({
    required this.staffId,
    required this.todayMarkedIds,
    required this.onAttendanceMarked,
  });

  @override
  State<_MembersTab> createState() => _MembersTabState();
}

class _MembersTabState extends State<_MembersTab> {
  final List<Customer> _members = [];
  int _page = 1;
  bool _hasMore = true;
  bool _loading = false;
  bool _initialLoad = true;
  String? _error;
  final ScrollController _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    _load();
  }

  @override
  void didUpdateWidget(_MembersTab old) {
    super.didUpdateWidget(old);
    if (old.staffId != widget.staffId) {
      _reload();
    }
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_scroll.position.pixels >= _scroll.position.maxScrollExtent - 200) {
      _load();
    }
  }

  void _reload() {
    setState(() {
      _members.clear();
      _page = 1;
      _hasMore = true;
      _error = null;
      _initialLoad = true;
    });
    _load();
  }

  Future<void> _load() async {
    if (_loading || !_hasMore) return;
    setState(() => _loading = true);
    try {
      final resp = await ApiService().getCustomers(
        page: _page,
        limit: 20,
        staffId: widget.staffId,
      );
      if (!mounted) return;
      setState(() {
        _members.addAll(resp.customers);
        _page++;
        _hasMore = _page <= resp.pages;
        _initialLoad = false;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      final err = e.toString().toLowerCase();
      if (err.contains('session') || err.contains('unauthorized') || err.contains('token') || err.contains('401')) {
        WidgetsBinding.instance.addPostFrameCallback((_) => context.go('/login'));
        return;
      }
      setState(() {
        _error = e.toString();
        _initialLoad = false;
      });
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_initialLoad && _loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null && _members.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text('Error: $_error'),
            const SizedBox(height: 12),
            ElevatedButton(onPressed: _reload, child: const Text('Retry')),
          ],
        ),
      );
    }
    if (!_loading && _members.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.people_outline, size: 64, color: Colors.grey[300]),
            const SizedBox(height: 16),
            Text('No customers assigned to you',
                style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            Text('Ask your business owner to assign customers',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.grey)),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: () async => _reload(),
      child: ListView.builder(
        controller: _scroll,
        padding: const EdgeInsets.all(12),
        itemCount: _members.length + (_hasMore ? 1 : 0),
        itemBuilder: (context, index) {
          if (index == _members.length) {
            return const Padding(
              padding: EdgeInsets.all(16),
              child: Center(child: CircularProgressIndicator()),
            );
          }
          final member = _members[index];
          final statusColor = _statusColor(member.status);
          return Card(
            margin: const EdgeInsets.only(bottom: 10),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              onTap: () => context.pushNamed(
                RouteNames.memberAttendance,
                extra: member,
              ),
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
                        const SizedBox(width: 4),
                        Icon(Icons.chevron_right, color: Colors.grey[400], size: 18),
                      ],
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(
                          child: _InfoChip(
                            icon: Icons.calendar_today,
                            label: 'Sub ends: ${_formatDate(member.subscriptionEndDate)}',
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
                    Builder(builder: (ctx) {
                      final alreadyMarked = widget.todayMarkedIds.contains(member.id);
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
                          onPressed: alreadyMarked ? null : () => _markAttendance(member),
                        ),
                      );
                    }),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  Future<void> _markAttendance(Customer member) async {
    final today = DateTime.now();
    final dateStr = '${today.year}-${today.month.toString().padLeft(2, '0')}-${today.day.toString().padLeft(2, '0')}';
    try {
      await ApiService().markAttendance(
        customerId: member.id,
        visitDate: dateStr,
      );
      widget.onAttendanceMarked(member.id);
      if (mounted) AppUiHelper().showModernSnackBar(context, message: "Attendance marked for ${member.name}");
    } catch (e) {
      if (mounted) AppUiHelper().showModernSnackBar(context, message: e.toString(), isError: true);
    }
  }

  Color _statusColor(String status) {
    switch (status) {
      case 'active':    return const Color(0xFF4CAF50);
      case 'at_risk':   return const Color(0xFFFF9800);
      case 'high_risk': return const Color(0xFFF44336);
      default:  return Colors.grey;
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

