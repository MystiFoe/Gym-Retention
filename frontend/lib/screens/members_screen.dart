import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../services/api_service.dart';
import '../models/models.dart';
import '../utils/file_download.dart';

// ============================================================================
// GLOBAL STATUS COLOR HELPER — use this everywhere for consistency
// ============================================================================
Color memberStatusColor(String status) {
  switch (status) {
    case 'active':    return const Color(0xFF4CAF50); // Green
    case 'at_risk':   return const Color(0xFFFF9800); // Amber/Orange
    case 'high_risk': return const Color(0xFFF44336); // Red
    default:          return Colors.grey;
  }
}

class MembersScreen extends StatefulWidget {
  const MembersScreen({super.key});

  @override
  State<MembersScreen> createState() => _MembersScreenState();
}

class _MembersScreenState extends State<MembersScreen> {
  late Future<MembersResponse> membersFuture;
  late Future<TrainersResponse> trainersFuture;
  int currentPage = 1;
  String selectedStatus = 'all';

  @override
  void initState() {
    super.initState();
    _loadMembers();
    trainersFuture = ApiService().getTrainers();
  }

  void _loadMembers() {
    membersFuture = ApiService().getMembers(
      page: currentPage,
      status: selectedStatus == 'all' ? null : selectedStatus,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Members'),
        actions: [
          IconButton(
            icon: const Icon(Icons.download),
            tooltip: 'Export CSV',
            onPressed: _exportCsv,
          ),
        ],
      ),
      body: Column(
        children: [
          // Status filter chips
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  _filterChip('all', 'All', Colors.blueGrey),
                  _filterChip('active', 'Active', memberStatusColor('active')),
                  _filterChip('at_risk', 'At Risk', memberStatusColor('at_risk')),
                  _filterChip('high_risk', 'High Risk', memberStatusColor('high_risk')),
                ],
              ),
            ),
          ),
          Expanded(
            child: FutureBuilder<MembersResponse>(
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
                        const Icon(Icons.error_outline, size: 48, color: Colors.red),
                        const SizedBox(height: 12),
                        Text('Error: ${snapshot.error}'),
                        const SizedBox(height: 12),
                        ElevatedButton(onPressed: () => setState(_loadMembers), child: const Text('Retry')),
                      ],
                    ),
                  );
                }

                final response = snapshot.data!;

                if (response.members.isEmpty) {
                  return Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.people_outline, size: 64, color: Colors.grey[300]),
                        const SizedBox(height: 16),
                        Text('No members found', style: Theme.of(context).textTheme.titleMedium),
                      ],
                    ),
                  );
                }

                return Column(
                  children: [
                    Expanded(
                      child: RefreshIndicator(
                        onRefresh: () async => setState(_loadMembers),
                        child: ListView.builder(
                          itemCount: response.members.length,
                          padding: const EdgeInsets.all(8),
                          itemBuilder: (context, index) {
                            final member = response.members[index];
                            final color = memberStatusColor(member.status);
                            return Card(
                              margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                              child: ListTile(
                                leading: CircleAvatar(
                                  backgroundColor: color.withValues(alpha: 0.15),
                                  child: Text(
                                    member.name[0].toUpperCase(),
                                    style: TextStyle(color: color, fontWeight: FontWeight.bold),
                                  ),
                                ),
                                title: Text(member.name, style: const TextStyle(fontWeight: FontWeight.bold)),
                                subtitle: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(member.phone),
                                    Text(
                                      'Last visit: ${member.daysSinceLastVisit == 999 ? "Never" : "${member.daysSinceLastVisit}d ago"} • Expires in: ${member.daysUntilExpiry}d',
                                      style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.grey[600]),
                                    ),
                                  ],
                                ),
                                isThreeLine: true,
                                trailing: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                      decoration: BoxDecoration(
                                        color: color.withValues(alpha: 0.1),
                                        borderRadius: BorderRadius.circular(8),
                                        border: Border.all(color: color.withValues(alpha: 0.4)),
                                      ),
                                      child: Text(
                                        member.statusDisplay,
                                        style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.bold),
                                      ),
                                    ),
                                    PopupMenuButton<String>(
                                      onSelected: (value) {
                                        if (value == 'edit') _showEditMemberDialog(context, member);
                                        if (value == 'delete') _confirmDelete(context, member);
                                        if (value == 'erase') _confirmEraseData(context, member);
                                      },
                                      itemBuilder: (_) => const [
                                        PopupMenuItem(value: 'edit', child: Text('Edit')),
                                        PopupMenuItem(value: 'delete', child: Text('Delete', style: TextStyle(color: Colors.red))),
                                        PopupMenuDivider(),
                                        PopupMenuItem(value: 'erase', child: Text('Erase Data (GDPR)', style: TextStyle(color: Colors.red))),
                                      ],
                                    ),
                                  ],
                                ),
                                onTap: () => _showMemberDetails(context, member),
                              ),
                            );
                          },
                        ),
                      ),
                    ),
                    if (response.pages > 1)
                      Padding(
                        padding: const EdgeInsets.all(12),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            IconButton(
                              icon: const Icon(Icons.chevron_left),
                              onPressed: currentPage > 1 ? () => setState(() { currentPage--; _loadMembers(); }) : null,
                            ),
                            Text('Page $currentPage of ${response.pages}'),
                            IconButton(
                              icon: const Icon(Icons.chevron_right),
                              onPressed: currentPage < response.pages ? () => setState(() { currentPage++; _loadMembers(); }) : null,
                            ),
                          ],
                        ),
                      ),
                  ],
                );
              },
            ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _showAddMemberDialog(context),
        icon: const Icon(Icons.person_add),
        label: const Text('Add Member'),
      ),
    );
  }

  Widget _filterChip(String status, String label, Color color) {
    final selected = selectedStatus == status;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: FilterChip(
        label: Text(label, style: TextStyle(color: selected ? color : Colors.grey[700], fontWeight: selected ? FontWeight.bold : FontWeight.normal)),
        selected: selected,
        selectedColor: color.withValues(alpha: 0.15),
        checkmarkColor: color,
        side: BorderSide(color: selected ? color : Colors.grey[300]!),
        onSelected: (_) => setState(() {
          selectedStatus = status;
          currentPage = 1;
          _loadMembers();
        }),
      ),
    );
  }

  void _showMemberDetails(BuildContext context, Member member) {
    final color = memberStatusColor(member.status);
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
      builder: (ctx) => SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                CircleAvatar(
                  radius: 24,
                  backgroundColor: color.withValues(alpha: 0.15),
                  child: Text(member.name[0].toUpperCase(),
                      style: TextStyle(color: color, fontWeight: FontWeight.bold, fontSize: 20)),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(member.name,
                          style: Theme.of(ctx).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                        decoration: BoxDecoration(
                          color: color.withValues(alpha: 0.1),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text(member.statusDisplay,
                            style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.bold)),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const Divider(height: 24),
            _DetailRow('Phone', member.phone),
            _DetailRow('Email', member.email.isEmpty ? '-' : member.email),
            _DetailRow('Plan Fee', '₹${member.planFee.toStringAsFixed(0)}'),
            _DetailRow('Expiry', member.daysUntilExpiry > 0 ? "In ${member.daysUntilExpiry} days" : "Expired ${member.daysUntilExpiry.abs()} days ago"),
            _DetailRow('Last Visit', member.daysSinceLastVisit == 999 ? 'Never visited' : '${member.daysSinceLastVisit} days ago'),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: ElevatedButton.icon(
                    icon: const Icon(Icons.edit, size: 16),
                    label: const Text('Edit'),
                    onPressed: () { Navigator.pop(ctx); _showEditMemberDialog(context, member); },
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: OutlinedButton.icon(
                    style: OutlinedButton.styleFrom(foregroundColor: Colors.red, side: const BorderSide(color: Colors.red)),
                    icon: const Icon(Icons.delete_outline, size: 16),
                    label: const Text('Delete'),
                    onPressed: () { Navigator.pop(ctx); _confirmDelete(context, member); },
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _exportCsv() async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final bytes = await ApiService().exportMembersCsv();
      final filename = 'members_${DateTime.now().toIso8601String().split('T')[0]}.csv';
      await downloadFile(bytes, filename, 'text/csv');
    } catch (e) {
      if (mounted) messenger.showSnackBar(SnackBar(content: Text('Export failed: $e'), backgroundColor: Colors.red));
    }
  }

  void _confirmEraseData(BuildContext context, Member member) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Erase Personal Data'),
        content: Text(
          'This will permanently erase all personal data for "${member.name}" to comply with a deletion request.\n\n'
          'Their name, phone, email and attendance records will be deleted. '
          'Task and revenue records are anonymised and kept for reporting.\n\n'
          'This cannot be undone.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: Colors.red, foregroundColor: Colors.white),
            onPressed: () async {
              final messenger = ScaffoldMessenger.of(context);
              Navigator.pop(ctx);
              try {
                await ApiService().deleteMemberData(member.id);
                if (mounted) {
                  setState(_loadMembers);
                  messenger.showSnackBar(const SnackBar(
                    content: Text('Personal data erased'),
                    backgroundColor: Colors.green,
                  ));
                }
              } catch (e) {
                if (mounted) messenger.showSnackBar(SnackBar(content: Text('Error: $e'), backgroundColor: Colors.red));
              }
            },
            child: const Text('Erase Data'),
          ),
        ],
      ),
    );
  }

  void _confirmDelete(BuildContext context, Member member) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete Member'),
        content: Text('Are you sure you want to remove ${member.name}? This cannot be undone.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: Colors.red, foregroundColor: Colors.white),
            onPressed: () async {
              final messenger = ScaffoldMessenger.of(context);
              Navigator.pop(ctx);
              try {
                await ApiService().deleteMember(member.id);
                if (mounted) {
                  setState(_loadMembers);
                  messenger.showSnackBar(const SnackBar(content: Text('Member removed')));
                }
              } catch (e) {
                if (mounted) messenger.showSnackBar(SnackBar(content: Text('Error: $e')));
              }
            },
            child: const Text('Delete'),
          ),
        ],
      ),
    );
  }

  Future<void> _showAddMemberDialog(BuildContext context) async {
    TrainersResponse? response;
    try {
      response = await trainersFuture;
    } catch (_) {}

    if (!mounted) return;

    if (response != null && response.trainers.isEmpty) {
      showDialog(
        context: this.context,
        builder: (ctx) => AlertDialog(
          title: const Text('No Trainers Yet'),
          content: const Text(
            'You need to add at least one trainer before adding members. '
            'Go to the Trainers section to add your first trainer.',
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
            ElevatedButton(
              onPressed: () {
                Navigator.pop(ctx);
                this.context.go('/owner/trainers');
              },
              child: const Text('Add Trainer'),
            ),
          ],
        ),
      );
      return;
    }

    _openAddMemberForm(this.context);
  }

  void _openAddMemberForm(BuildContext context) {
    final formKey = GlobalKey<FormState>();
    final nameController = TextEditingController();
    final phoneController = TextEditingController();
    final emailController = TextEditingController();
    final feeController = TextEditingController();
    DateTime expiryDate = DateTime.now().add(const Duration(days: 30));
    DateTime? lastVisitDate;
    String? selectedTrainerId;

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: const Text('Add Member'),
          content: SingleChildScrollView(
            child: Form(
              key: formKey,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextFormField(
                    controller: nameController,
                    decoration: const InputDecoration(labelText: 'Full Name *', prefixIcon: Icon(Icons.person)),
                    validator: (v) {
                      if (v == null || v.trim().isEmpty) return 'Name is required';
                      if (v.trim().length < 2) return 'Name must be at least 2 characters';
                      return null;
                    },
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: phoneController,
                    keyboardType: TextInputType.phone,
                    decoration: const InputDecoration(labelText: 'Phone Number *', prefixIcon: Icon(Icons.phone)),
                    validator: (v) {
                      if (v == null || v.trim().isEmpty) return 'Phone number is required';
                      if (!RegExp(r'^\d{10,15}$').hasMatch(v.replaceAll(RegExp(r'[\s\-+()]'), ''))) {
                        return 'Enter a valid phone number (10–15 digits)';
                      }
                      return null;
                    },
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: emailController,
                    keyboardType: TextInputType.emailAddress,
                    decoration: const InputDecoration(labelText: 'Email Address *', prefixIcon: Icon(Icons.email)),
                    validator: (v) {
                      if (v == null || v.trim().isEmpty) return 'Email is required';
                      if (!RegExp(r'^[\w\.\-]+@[\w\-]+\.\w{2,}$').hasMatch(v.trim())) {
                        return 'Enter a valid email address';
                      }
                      return null;
                    },
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: feeController,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(labelText: 'Plan Fee (₹) *', prefixIcon: Icon(Icons.currency_rupee)),
                    validator: (v) {
                      if (v == null || v.trim().isEmpty) return 'Plan fee is required';
                      final fee = double.tryParse(v);
                      if (fee == null || fee <= 0) return 'Enter a valid fee amount';
                      return null;
                    },
                  ),
                  const SizedBox(height: 12),
                  FutureBuilder<TrainersResponse>(
                    future: trainersFuture,
                    builder: (context, snapshot) {
                      final trainers = snapshot.data?.trainers ?? [];
                      return DropdownButtonFormField<String>(
                        decoration: const InputDecoration(
                          labelText: 'Assign Trainer *',
                          prefixIcon: Icon(Icons.person_pin),
                        ),
                        initialValue: selectedTrainerId,
                        items: trainers
                            .map((t) => DropdownMenuItem<String>(
                                  value: t.id,
                                  child: Text(t.name),
                                ))
                            .toList(),
                        onChanged: (v) => setDialogState(() => selectedTrainerId = v),
                        validator: (_) => selectedTrainerId == null ? 'Please assign a trainer' : null,
                      );
                    },
                  ),
                  const SizedBox(height: 12),
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.fitness_center, color: Colors.grey),
                    title: const Text('Last Visit Date'),
                    subtitle: Text(lastVisitDate != null
                        ? lastVisitDate!.toString().split(' ')[0]
                        : 'Tap to set (optional)',
                        style: TextStyle(color: lastVisitDate != null ? Colors.black87 : Colors.grey)),
                    onTap: () async {
                      final d = await showDatePicker(
                        context: ctx,
                        initialDate: DateTime.now(),
                        firstDate: DateTime.now().subtract(const Duration(days: 365)),
                        lastDate: DateTime.now(),
                      );
                      if (d != null) setDialogState(() => lastVisitDate = d);
                    },
                  ),
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.calendar_today, color: Colors.blue),
                    title: const Text('Membership Expiry *'),
                    subtitle: Text(expiryDate.toString().split(' ')[0]),
                    onTap: () async {
                      final d = await showDatePicker(
                        context: ctx,
                        initialDate: expiryDate,
                        firstDate: DateTime.now(),
                        lastDate: DateTime.now().add(const Duration(days: 3650)),
                      );
                      if (d != null) setDialogState(() => expiryDate = d);
                    },
                  ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
            ElevatedButton(
              onPressed: () async {
                if (!formKey.currentState!.validate()) return;
                if (selectedTrainerId == null) return;
                final messenger = ScaffoldMessenger.of(context);
                final nav = Navigator.of(ctx);
                try {
                  await ApiService().createMember(
                    name: nameController.text.trim(),
                    phone: phoneController.text.trim(),
                    email: emailController.text.trim(),
                    lastVisitDate: lastVisitDate?.toString().split(' ')[0],
                    membershipExpiryDate: expiryDate.toUtc().toIso8601String(),
                    planFee: double.parse(feeController.text),
                    assignedTrainerId: selectedTrainerId!,
                  );
                  if (mounted) {
                    nav.pop();
                    setState(_loadMembers);
                    messenger.showSnackBar(const SnackBar(
                      content: Text('Member added successfully'),
                      backgroundColor: Colors.green,
                    ));
                  }
                } catch (e) {
                  messenger.showSnackBar(SnackBar(
                    content: Text('$e'),
                    backgroundColor: Colors.red,
                  ));
                }
              },
              child: const Text('Add Member'),
            ),
          ],
        ),
      ),
    );
  }

  void _showEditMemberDialog(BuildContext context, Member member) {
    final formKey = GlobalKey<FormState>();
    final nameController = TextEditingController(text: member.name);
    final phoneController = TextEditingController(text: member.phone);
    final emailController = TextEditingController(text: member.email);
    final feeController = TextEditingController(text: member.planFee.toStringAsFixed(0));
    DateTime expiryDate = member.membershipExpiryDate;

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: const Text('Edit Member'),
          content: SingleChildScrollView(
            child: Form(
              key: formKey,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextFormField(
                    controller: nameController,
                    decoration: const InputDecoration(labelText: 'Full Name *', prefixIcon: Icon(Icons.person)),
                    validator: (v) {
                      if (v == null || v.trim().isEmpty) return 'Name is required';
                      if (v.trim().length < 2) return 'Name must be at least 2 characters';
                      return null;
                    },
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: phoneController,
                    keyboardType: TextInputType.phone,
                    decoration: const InputDecoration(labelText: 'Phone Number *', prefixIcon: Icon(Icons.phone)),
                    validator: (v) {
                      if (v == null || v.trim().isEmpty) return 'Phone number is required';
                      if (!RegExp(r'^\d{10,15}$').hasMatch(v.replaceAll(RegExp(r'[\s\-+()]'), ''))) {
                        return 'Enter a valid phone number (10–15 digits)';
                      }
                      return null;
                    },
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: emailController,
                    keyboardType: TextInputType.emailAddress,
                    decoration: const InputDecoration(labelText: 'Email Address *', prefixIcon: Icon(Icons.email)),
                    validator: (v) {
                      if (v == null || v.trim().isEmpty) return 'Email is required';
                      if (!RegExp(r'^[\w\.\-]+@[\w\-]+\.\w{2,}$').hasMatch(v.trim())) {
                        return 'Enter a valid email address';
                      }
                      return null;
                    },
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: feeController,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(labelText: 'Plan Fee (₹) *', prefixIcon: Icon(Icons.currency_rupee)),
                    validator: (v) {
                      if (v == null || v.trim().isEmpty) return 'Plan fee is required';
                      final fee = double.tryParse(v);
                      if (fee == null || fee <= 0) return 'Enter a valid fee amount';
                      return null;
                    },
                  ),
                  const SizedBox(height: 12),
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.calendar_today, color: Colors.blue),
                    title: const Text('Membership Expiry *'),
                    subtitle: Text(expiryDate.toString().split(' ')[0]),
                    onTap: () async {
                      final d = await showDatePicker(
                        context: ctx,
                        initialDate: expiryDate,
                        firstDate: DateTime.now().subtract(const Duration(days: 30)),
                        lastDate: DateTime.now().add(const Duration(days: 3650)),
                      );
                      if (d != null) setDialogState(() => expiryDate = d);
                    },
                  ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
            ElevatedButton(
              onPressed: () async {
                if (!formKey.currentState!.validate()) return;
                final messenger = ScaffoldMessenger.of(context);
                final nav = Navigator.of(ctx);
                try {
                  await ApiService().updateMember(
                    memberId: member.id,
                    name: nameController.text.trim(),
                    phone: phoneController.text.trim(),
                    email: emailController.text.trim(),
                    membershipExpiryDate: expiryDate.toUtc().toIso8601String(),
                    planFee: double.parse(feeController.text),
                  );
                  if (mounted) {
                    nav.pop();
                    setState(_loadMembers);
                    messenger.showSnackBar(const SnackBar(
                      content: Text('Member updated successfully'),
                      backgroundColor: Colors.green,
                    ));
                  }
                } catch (e) {
                  messenger.showSnackBar(SnackBar(
                    content: Text('$e'),
                    backgroundColor: Colors.red,
                  ));
                }
              },
              child: const Text('Save Changes'),
            ),
          ],
        ),
      ),
    );
  }
}

class _DetailRow extends StatelessWidget {
  final String label;
  final String value;
  const _DetailRow(this.label, this.value);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: TextStyle(fontWeight: FontWeight.w600, color: Colors.grey[700])),
          Text(value, style: const TextStyle(fontWeight: FontWeight.w500)),
        ],
      ),
    );
  }
}
