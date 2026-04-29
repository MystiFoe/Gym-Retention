// ignore: avoid_web_libraries_in_flutter
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:gym_fitness_app/utils/app_routes.dart';
import 'package:gym_fitness_app/utils/app_utils.dart';
import 'package:gym_fitness_app/utils/appui_helper.dart';
import 'package:gym_fitness_app/widgets/customer_delete_popup.dart';
import '../services/api_service.dart';
import '../models/models.dart';
import 'add_customer_screen.dart';
import 'bulk_import_screen.dart';
import 'edit_customer_screen.dart';

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
  final int refreshTrigger;
  const MembersScreen({super.key, this.refreshTrigger = 0});

  @override
  State<MembersScreen> createState() => _MembersScreenState();
}

class _MembersScreenState extends State<MembersScreen> {
  // ── Infinite scroll state ────────────────────────────────────────────────
  final ScrollController _scrollController = ScrollController();
  final List<Customer> _members = [];
  int _currentPage = 1;
  int _totalPages = 1;
  bool _isLoading = false;
  bool _isLoadingMore = false;
  String? _error;
  String _selectedStatus = 'all';

  // Trainers future — still needed for the Add Customer dialog dropdown
  late Future<StaffResponse> trainersFuture;

  @override
  void initState() {
    super.initState();
    trainersFuture = ApiService().getStaff(limit: 100);
    _scrollController.addListener(_onScroll);
    _loadMembers(refresh: true);
  }

  @override
  void didUpdateWidget(MembersScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.refreshTrigger != oldWidget.refreshTrigger) {
      _loadMembers(refresh: true);
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
        _loadMembers();
      }
    }
  }

  Future<void> _loadMembers({bool refresh = false}) async {
    if (!refresh && (_isLoading || _isLoadingMore)) return;
    if (!refresh && _currentPage > _totalPages) return;

    setState(() {
      if (refresh) {
        _isLoading = true;
        _members.clear();
        _currentPage = 1;
        _totalPages = 1;
        _error = null;
      } else {
        _isLoadingMore = true;
      }
    });

    try {
      final response = await ApiService().getCustomers(
        page: _currentPage,
        status: _selectedStatus == 'all' ? null : _selectedStatus,
      );
      if (mounted) {
        setState(() {
          _members.addAll(response.customers);
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
      appBar: AppBar(
        title: const Text('Customers'),
        actions: [
          IconButton(
            icon: const Icon(Icons.upload_file),
            tooltip: 'Bulk Import',
            onPressed: () async {
              final refreshed = await Navigator.of(context).push<bool>(
                MaterialPageRoute(builder: (_) => const BulkImportScreen()),
              );
              if (refreshed == true) _loadMembers(refresh: true);
            },
          ),
          IconButton(
            icon: const Icon(Icons.download),
            tooltip: 'Export CSV',
            onPressed: (_exportCsv),
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
            child: _buildMemberList(),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        heroTag: 'members_fab',
        onPressed: () => _showAddMemberDialog(context),
        icon: const Icon(Icons.person_add),
        label: const Text('Add Customer'),
      ),
    );
  }

  Widget _buildMemberList() {
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
              onPressed: () => _loadMembers(refresh: true),
              child: const Text('Retry'),
            ),
          ],
        ),
      );
    }
    if (_members.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.people_outline, size: 64, color: Colors.grey[300]),
            const SizedBox(height: 16),
            Text('No customers found', style: Theme.of(context).textTheme.titleMedium),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: () => _loadMembers(refresh: true),
      child: ListView.builder(
        controller: _scrollController,
        itemCount: _members.length + (_isLoadingMore ? 1 : 0),
        padding: const EdgeInsets.all(8),
        itemBuilder: (context, index) {
          if (index == _members.length) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(16),
                child: CircularProgressIndicator(),
              ),
            );
          }
          final member = _members[index];
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
                    'Last visit: ${member.daysSinceLastVisit == 999 ? "Never" : "${member.daysSinceLastVisit}d ago"} • Sub ends in: ${member.daysUntilSubscriptionEnd}d',
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
              onTap: () => context.pushNamed(
                RouteNames.memberAttendance,
                extra: member,
              ),
            ),
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
        label: Text(label, style: TextStyle(color: selected ? color : Colors.grey[700], fontWeight: selected ? FontWeight.bold : FontWeight.normal)),
        selected: selected,
        selectedColor: color.withValues(alpha: 0.15),
        checkmarkColor: color,
        side: BorderSide(color: selected ? color : Colors.grey[300]!),
        onSelected: (_) {
          _selectedStatus = status;
          _loadMembers(refresh: true);
        },
      ),
    );
  }

  // ignore: unused_element
  void _showMemberDetails(BuildContext context, Customer member) {
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
            _DetailRow('Subscription End', member.daysUntilSubscriptionEnd > 0 ? "In ${member.daysUntilSubscriptionEnd} days" : "Expired ${member.daysUntilSubscriptionEnd.abs()} days ago"),
            _DetailRow('Last Visit', member.daysSinceLastVisit == 999 ? 'Never visited' : '${member.daysSinceLastVisit} days ago'),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: ElevatedButton.icon(
                    style: OutlinedButton.styleFrom(
                        backgroundColor: Colors.white,
                        foregroundColor: Colors.red,
                        side: const BorderSide(color: Colors.red)),
                    icon: const Icon(Icons.delete_outline, size: 16),
                    label: const Text('Delete'),
                    onPressed: () { Navigator.pop(ctx); _confirmDelete(context, member); },
                  ),
                ),
                const SizedBox(width: 12),

                Expanded(
                  child: ElevatedButton.icon(
                    icon: const Icon(Icons.edit, size: 16),
                    label: const Text('Edit'),
                    onPressed: () { Navigator.pop(ctx); _showEditMemberDialog(context, member); },
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
    try {
      final bytes = await ApiService().exportCustomersCsv();

      final dir = Directory('/storage/emulated/0/Download');
      final fileName =
          'customers_${DateTime.now().toIso8601String().split('T')[0]}.csv';
      final file = File('${dir.path}/$fileName');
      await file.writeAsBytes(bytes);

      if (mounted) {
        AppUiHelper().showModernSnackBar(context, message: 'Customer list downloaded successfully');
      }
    } catch (_) {
      if (mounted) {
        AppUiHelper().showModernSnackBar(context, message: 'Download failed. Please try again.', isError: true);
      }
    }
  }


  void _confirmEraseData(BuildContext context, Customer member) {
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
              Navigator.pop(ctx);
              try {
                await ApiService().deleteCustomerData(member.id);
                if (!context.mounted) return;
                _loadMembers(refresh: true);
                AppUiHelper().showModernSnackBar(context, message: "Personal data erased");
              } catch (e) {
                if (!context.mounted) return;
                AppUiHelper().showModernSnackBar(context, message: e.toString(), isError: true);

              }
            },
            child: const Text('Erase Data'),
          ),
        ],
      ),
    );
  }

  void _confirmDelete(BuildContext context, Customer member) {
    AppUiHelper.showCustomDialog(MemberDeletePopup(member: member, onTap: () {
      _loadMembers(refresh: true);
      // AppUiHelper().showModernSnackBar(context, message: "Customer removed");

      // ScaffoldMessenger.of(context).showSnackBar(
      //     const SnackBar(content: Text('Customer removed')));
    },));

    // showDialog(
    //   context: context,
    //   builder: (ctx) => AlertDialog(
    //     title: const Text('Delete Customer'),
    //     content: Text('Are you sure you want to remove ${member.name}? This cannot be undone.'),
    //     actions: [
    //       TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
    //       ElevatedButton(
    //         style: ElevatedButton.styleFrom(backgroundColor: Colors.red, foregroundColor: Colors.white),
    //         onPressed: () async {
    //           final messenger = ScaffoldMessenger.of(context);
    //           Navigator.pop(ctx);
    //           try {
    //             await ApiService().deleteCustomer(member.id);
    //             if (mounted) {
    //               setState(_loadMembers);
    //               messenger.showSnackBar(const SnackBar(content: Text('Customer removed')));
    //             }
    //           } catch (e) {
    //             if (mounted) messenger.showSnackBar(SnackBar(content: Text('Error: $e')));
    //           }
    //         },
    //         child: const Text('Delete'),
    //       ),
    //     ],
    //   ),
    // );
  }

  Future<void> _showAddMemberDialog(BuildContext context) async {
    if (!mounted) return;

// Instead of showDialog, navigate to screen:
    final result = await Navigator.push(
      context,
      MaterialPageRoute(builder: (_) => const AddMemberScreen()),
    );
    if (result == true) _loadMembers(refresh: true); // refresh list
    // _openAddMemberForm(this.context);
  }

  // ignore: unused_element
  void _openAddMemberForm(BuildContext context) {
    final formKey = GlobalKey<FormState>();
    final nameController = TextEditingController();
    final phoneController = TextEditingController();
    final emailController = TextEditingController();
    final feeController = TextEditingController();
    DateTime expiryDate = DateTime.now().add(const Duration(days: 30));
    DateTime? lastVisitDate;
    String? selectedTrainerId;
    String? phoneError;
    String? nameError;
    String? emailError;
    String? feeError;


    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: const Text('Add Customer'),
          content: SizedBox(
            width: MediaQuery.sizeOf(context).width *0.9 ,
            child: SingleChildScrollView(
              child: Form(
                key: formKey,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    TextFormField(
                      autovalidateMode: AutovalidateMode.onUserInteraction,

                      controller: nameController,
                      decoration:  InputDecoration(labelText: 'Full Name *', prefixIcon: Icon(Icons.person),errorText: nameError),
                      validator: (v) {
                        if (v == null || v.trim().isEmpty) return 'Name is required';
                        if (v.trim().length < 3) return 'Name must be at least 3 characters';
                        return null;
                      },
                      onChanged: (v){
                        setDialogState((){
                          nameError = AppUtils.validateName(v);
                        });
                      },
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      autovalidateMode: AutovalidateMode.onUserInteraction,

                      controller: phoneController,
                      keyboardType: TextInputType.phone,
                      decoration: InputDecoration(
                          labelText: 'Phone Number *',
                          prefixIcon: const Icon(Icons.phone),
                          errorText: phoneError
                      ),
                      validator: (v) => AppUtils.validatePhoneNumber(v),
                      // {
                      //   if (v == null || v.trim().isEmpty) return 'Phone number is required';
                      //   if (!RegExp(r'^\d{10,15}$').hasMatch(v.replaceAll(RegExp(r'[\s\-+()]'), ''))) {
                      //     return 'Enter a valid phone number (10 digits)';
                      //   }
                      //   return null;
                      // },
                      onChanged: (v){
                        setDialogState(() {
                          phoneError = AppUtils.validatePhoneNumber(v);
                        });
                      },
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      autovalidateMode: AutovalidateMode.onUserInteraction,

                      controller: emailController,
                      keyboardType: TextInputType.emailAddress,
                      decoration: InputDecoration(
                          labelText: 'Email Address *', prefixIcon: Icon(
                          Icons.email,
                      ),
                        errorText: emailError
                      ),
                      validator: (v) => AppUtils.validateEmail(v),
                      onChanged: (v){
                        setDialogState((){
                          emailError = AppUtils.validateEmail(v);
                        });
                      },
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      autovalidateMode: AutovalidateMode.onUserInteraction,

                      controller: feeController,
                      keyboardType: TextInputType.number,
                      decoration: InputDecoration(
                          labelText: 'Plan Fee (₹) *',
                          prefixIcon: Icon(
                          Icons.currency_rupee),
                          errorText: feeError
                      ),
                      validator: (v) => AppUtils.validatePlanFee(v),
                      onChanged: (v){
                        setDialogState((){
                          feeError =AppUtils.validatePlanFee(v);
                        });
                      },
                      // {
                      //   if (v == null || v.trim().isEmpty) return 'Plan fee is required';
                      //   final fee = double.tryParse(v);
                      //   if (fee == null || fee <= 0) return 'Enter a valid fee amount';
                      //   return null;
                      // },
                    ),
                    const SizedBox(height: 12),
                    FutureBuilder<StaffResponse>(
                      future: trainersFuture,
                      builder: (context, snapshot) {
                        final trainers = snapshot.data?.staff ?? [];
                        return DropdownButtonFormField<String>(
                          decoration: const InputDecoration(
                            labelText: 'Assign Staff *',
                            prefixIcon: Icon(Icons.person_pin),
                          ),
                          initialValue: selectedTrainerId,
                          items: trainers
                              .map((t) => DropdownMenuItem<String>(
                            value: t.id,
                            child: Text(t.name),
                          ))
                              .toList(),
                          autovalidateMode: AutovalidateMode.onUserInteraction,

                          onChanged: (v) => setDialogState(() => selectedTrainerId = v),
                          validator: (_) => null,
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
                      title: const Text('Subscription End *'),
                      subtitle: Text(expiryDate.toString().split(' ')[0]),
                      onTap: () async {
                        final d = await showCustomDialogDatePicker(
                          context: ctx,
                          initialDate: expiryDate,
                        );

                        if (d != null) {
                          setDialogState(() => expiryDate = d);
                        }
                      },

                      // onTap: () async {
                      //   final d = await showDatePicker(
                      //     context: ctx,
                      //     initialDate: expiryDate,
                      //     firstDate: DateTime.now(),
                      //     lastDate: DateTime.now().add(const Duration(days: 3650)),
                      //     builder: (context, child) {
                      //       return Theme(
                      //         data: Theme.of(context).copyWith(
                      //           dialogTheme: const DialogThemeData(
                      //             shape: RoundedRectangleBorder(
                      //               borderRadius: BorderRadius.all(Radius.circular(16)),
                      //             ),
                      //           ),
                      //         ),
                      //         child: child!,
                      //       );
                      //     },
                      //   );
                      //
                      //   // final d = await showDatePicker(
                      //   //   context: ctx,
                      //   //   initialDate: expiryDate,
                      //   //   firstDate: DateTime.now(),
                      //   //   lastDate: DateTime.now().add(const Duration(days: 3650)),
                      //   //   builder: (context, child) {
                      //   //     return Theme(
                      //   //       data: Theme.of(context).copyWith(
                      //   //         dialogTheme: const DialogThemeData(
                      //   //           shape: RoundedRectangleBorder(
                      //   //             borderRadius: BorderRadius.all(Radius.circular(16)),
                      //   //           ),
                      //   //         ),
                      //   //       ),
                      //   //       child: ConstrainedBox(
                      //   //         constraints: BoxConstraints(
                      //   //           maxWidth: MediaQuery.of(context).size.width,
                      //   //           maxHeight: MediaQuery.of(context).size.height ,
                      //   //         ),
                      //   //         child: child!,
                      //   //       ),
                      //   //     );
                      //   //   },
                      //   // );
                      //   if (d != null) setDialogState(() => expiryDate = d);
                      // },
                    ),
                    // ListTile(
                    //   contentPadding: EdgeInsets.zero,
                    //   leading: const Icon(Icons.calendar_today, color: Colors.blue),
                    //   title: const Text('Membership Expiry *'),
                    //   subtitle: Text(expiryDate.toString().split(' ')[0]),
                    //   onTap: () async {
                    //     final d = await showDatePicker(
                    //       context: ctx,
                    //       initialDate: expiryDate,
                    //       firstDate: DateTime.now(),
                    //       lastDate: DateTime.now().add(const Duration(days: 3650)),
                    //     );
                    //     if (d != null) setDialogState(() => expiryDate = d);
                    //   },
                    // ),
                  ],
                ),
              ),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
            ElevatedButton(
              onPressed: () async {
                if (!formKey.currentState!.validate()) return;
                if (selectedTrainerId == null) return;
                final nav = Navigator.of(ctx);
                try {
                  await ApiService().createCustomer(
                    name: nameController.text.trim(),
                    phone: phoneController.text.trim(),
                    email: emailController.text.trim(),
                    lastVisitDate: lastVisitDate?.toString().split(' ')[0],
                    subscriptionEndDate: expiryDate.toUtc().toIso8601String(),
                    planFee: double.parse(feeController.text),
                    assignedStaffId: selectedTrainerId!,
                  );
                  if (!context.mounted) return;
                  nav.pop();
                  _loadMembers(refresh: true);
                  AppUiHelper().showModernSnackBar(context, message: "Customer added successfully");
                } catch (e) {
                  if (!context.mounted) return;
                  AppUiHelper().showModernSnackBar(context, message: e.toString(), isError: true);
                }
              },
              child: const Text('Add Customer'),
            ),
          ],
        )
      ),
    );
  }

  void _showEditMemberDialog(BuildContext context, Customer member) async{
    // Instead of showDialog, navigate to screen:
    final result = await Navigator.push(
      context,
      MaterialPageRoute(builder: (_) => EditMemberScreen(member: member)),
    );
    if (result == true) _loadMembers(refresh: true); // refresh list
    // final formKey = GlobalKey<FormState>();
    // final nameController = TextEditingController(text: member.name);
    // final phoneController = TextEditingController(text: member.phone);
    // final emailController = TextEditingController(text: member.email);
    // final feeController = TextEditingController(text: member.planFee.toStringAsFixed(0));
    // DateTime expiryDate = member.subscriptionEndDate;
    // DateTime? lastVisitDate;
    // String? selectedTrainerId;
    // String? phoneError;
    // String? nameError;
    // String? emailError;
    // String? feeError;
    // showDialog(
    //   context: context,
    //   builder: (ctx) => StatefulBuilder(
    //     builder: (ctx, setDialogState) => AlertDialog(
    //       title: const Text('Edit Customer'),
    //       content: SizedBox(
    //         width: MediaQuery.sizeOf(context).width *0.9 ,
    //
    //         child: SingleChildScrollView(
    //           child: Form(
    //             key: formKey,
    //             child: Column(
    //               mainAxisSize: MainAxisSize.min,
    //               children: [
    //                 TextFormField(
    //                   autovalidateMode: AutovalidateMode.onUserInteraction,
    //                   controller: nameController,
    //                   decoration:  InputDecoration(labelText: 'Full Name *', prefixIcon: Icon(Icons.person),errorText: nameError),
    //                   validator: (v) => AppUtils.validateName(v),
    //                   // {
    //                   //   if (v == null || v.trim().isEmpty) return 'Name is required';
    //                   //   if (v.trim().length < 2) return 'Name must be at least 2 characters';
    //                   //   return null;
    //                   // },
    //                   onChanged: (v){
    //                     setDialogState((){
    //                       nameError = AppUtils.validateName(v);
    //                     });
    //                   },
    //                 ),
    //                 const SizedBox(height: 12),
    //                 TextFormField(
    //                   autovalidateMode: AutovalidateMode.onUserInteraction,
    //
    //                   controller: phoneController,
    //                   keyboardType: TextInputType.phone,
    //                   decoration:  InputDecoration(labelText: 'Phone Number *', prefixIcon: Icon(Icons.phone),errorText: phoneError),
    //                   validator: (v)  =>  AppUtils.validatePhoneNumber(v),
    //                   // {
    //                   //   if (v == null || v.trim().isEmpty) return 'Phone number is required';
    //                   //   if (!RegExp(r'^\d{10,15}$').hasMatch(v.replaceAll(RegExp(r'[\s\-+()]'), ''))) {
    //                   //     return 'Enter a valid phone number (10–15 digits)';
    //                   //   }
    //                   //   return null;
    //                   // },
    //                   onChanged: (v){
    //                     setDialogState((){
    //                       phoneError = AppUtils.validatePhoneNumber(v);
    //                     });
    //                   },
    //                 ),
    //                 const SizedBox(height: 12),
    //                 TextFormField(
    //                   autovalidateMode: AutovalidateMode.onUserInteraction,
    //
    //                   controller: emailController,
    //                   keyboardType: TextInputType.emailAddress,
    //                   decoration:  InputDecoration(labelText: 'Email Address *', prefixIcon: Icon(Icons.email),errorText: emailError),
    //                   validator: (v)  => AppUtils.validateEmail(v),
    //                   // {
    //                   //   if (v == null || v.trim().isEmpty) return 'Email is required';
    //                   //   if (!RegExp(r'^[\w\.\-]+@[\w\-]+\.\w{2,}$').hasMatch(v.trim())) {
    //                   //     return 'Enter a valid email address';
    //                   //   }
    //                   //   return null;
    //                   // },
    //                   onChanged: (v){
    //                     setDialogState((){
    //                       emailError = AppUtils.validateEmail(v);
    //                     });
    //                   },
    //                 ),
    //                 const SizedBox(height: 12),
    //                 TextFormField(
    //                   autovalidateMode: AutovalidateMode.onUserInteraction,
    //
    //                   controller: feeController,
    //                   keyboardType: TextInputType.number,
    //                   decoration:  InputDecoration(labelText: 'Plan Fee (₹) *', prefixIcon: Icon(Icons.currency_rupee),errorText: feeError),
    //                   validator: (v)  => AppUtils.validatePlanFee(v),
    //                   // {
    //                   //   if (v == null || v.trim().isEmpty) return 'Plan fee is required';
    //                   //   final fee = double.tryParse(v);
    //                   //   if (fee == null || fee <= 0) return 'Enter a valid fee amount';
    //                   //   return null;
    //                   // },
    //                   onChanged: (v){
    //                     setDialogState((){
    //                       feeError = AppUtils.validatePlanFee(v);
    //                     });
    //                   },
    //                 ),
    //                 const SizedBox(height: 12),
    //                 ListTile(
    //                   contentPadding: EdgeInsets.zero,
    //                   leading: const Icon(Icons.calendar_today, color: Colors.blue),
    //                   title: const Text('Membership Expiry *'),
    //                   subtitle: Text(expiryDate.toString().split(' ')[0]),
    //                   onTap: () async {
    //                     final d = await showDatePicker(
    //                       context: ctx,
    //                       initialDate: expiryDate,
    //                       firstDate: DateTime.now().subtract(const Duration(days: 30)),
    //                       lastDate: DateTime.now().add(const Duration(days: 3650)),
    //                     );
    //                     if (d != null) setDialogState(() => expiryDate = d);
    //                   },
    //                 ),
    //               ],
    //             ),
    //           ),
    //         ),
    //       ),
    //       actions: [
    //         TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
    //         ElevatedButton(
    //           onPressed: () async {
    //             if (!formKey.currentState!.validate()) return;
    //             final messenger = ScaffoldMessenger.of(context);
    //             final nav = Navigator.of(ctx);
    //             try {
    //               await ApiService().updateCustomer(
    //                 customerId: member.id,
    //                 staffId: member.assignedStaffId ??"",
    //                 name: nameController.text.trim(),
    //                 phone: phoneController.text.trim(),
    //                 email: emailController.text.trim(),
    //                 subscriptionEndDate: expiryDate.toUtc().toIso8601String(),
    //                 planFee: double.parse(feeController.text),
    //               );
    //               if (mounted) {
    //                 nav.pop();
    //                 setState(_loadMembers);
    //                 AppUiHelper().showModernSnackBar(context, message: "Customer updated successfully");
    //
    //                 // messenger.showSnackBar(const SnackBar(
    //                 //   content: Text('Customer updated successfully'),
    //                 //   backgroundColor: Colors.green,
    //                 // ));
    //               }
    //             } catch (e) {
    //               AppUiHelper().showModernSnackBar(context, message: "Something Went Wrong",isError: true);
    //
    //             }
    //           },
    //           child: const Text('Save Changes'),
    //         ),
    //       ],
    //     ),
    //   ),
    // );
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

Future<DateTime?> showCustomDialogDatePicker({
  required BuildContext context,
  required DateTime initialDate,
}) {
  DateTime selectedDate = initialDate;

  return showDialog<DateTime>(
    context: context,
    builder: (context) {
      return Dialog(
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
        ),
        child: SizedBox(
          height: MediaQuery.of(context).size.height * 0.66,
          child: StatefulBuilder(
            builder: (context, setState) {
              return Column(
                children: [
                  const SizedBox(height: 12),
                  const Text(
                    "Select Date",
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                  ),

                  Expanded(
                    child: CalendarDatePicker(
                      initialDate: selectedDate,
                      firstDate: DateTime.now(),
                      lastDate: DateTime.now().add(const Duration(days: 3650)),
                      onDateChanged: (date) {
                        setState(() => selectedDate = date);
                      },
                    ),
                  ),

                  Padding(
                    padding: const EdgeInsets.all(12),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        TextButton(
                          onPressed: () => Navigator.pop(context),
                          child: const Text("Cancel"),
                        ),
                        ElevatedButton(
                          onPressed: () {
                            Navigator.pop(context, selectedDate);
                          },
                          child: const Text("OK"),
                        ),
                      ],
                    ),
                  )
                ],
              );
            },
          ),
        ),
      );

      // return Dialog(
      //   shape: RoundedRectangleBorder(
      //     borderRadius: BorderRadius.circular(16),
      //   ),
      //   child: StatefulBuilder(
      //     builder: (context, setState) {
      //       return Padding(
      //         padding: const EdgeInsets.all(16),
      //         child: Column(
      //           mainAxisSize: MainAxisSize.min,
      //           children: [
      //             const Text(
      //               "Select Date",
      //               style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
      //             ),
      //
      //             const SizedBox(height: 10),
      //
      //             CalendarDatePicker(
      //               initialDate: selectedDate,
      //               firstDate: DateTime.now(),
      //               lastDate: DateTime.now().add(const Duration(days: 3650)),
      //               onDateChanged: (date) {
      //                 setState(() {
      //                   selectedDate = date;
      //                 });
      //               },
      //             ),
      //
      //             const SizedBox(height: 10),
      //
      //             Row(
      //               mainAxisAlignment: MainAxisAlignment.end,
      //               children: [
      //                 TextButton(
      //                   onPressed: () => Navigator.pop(context),
      //                   child: const Text("Cancel"),
      //                 ),
      //                 ElevatedButton(
      //                   onPressed: () {
      //                     Navigator.pop(context, selectedDate);
      //                   },
      //                   child: const Text("OK"),
      //                 ),
      //               ],
      //             )
      //           ],
      //         ),
      //       );
      //     },
      //   ),
      // );
    },
  );
}

// Future<DateTime?> showCustomDialogDatePicker({
//   required BuildContext context,
//   required DateTime initialDate,
// }) {
//   DateTime selectedDate = initialDate;
//
//   return showModalBottomSheet<DateTime>(
//     context: context,
//     isScrollControlled: true,
//     shape: const RoundedRectangleBorder(
//       borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
//     ),
//     builder: (context) {
//       return StatefulBuilder(
//         builder: (context, setState) {
//           return Padding(
//             padding: const EdgeInsets.all(16),
//             child: Column(
//               mainAxisSize: MainAxisSize.min,
//               children: [
//                 /// HEADER
//                 Row(
//                   mainAxisAlignment: MainAxisAlignment.spaceBetween,
//                   children: [
//                     Text(
//                       "Select Date",
//                       style: Theme.of(context).textTheme.titleLarge,
//                     ),
//                     IconButton(
//                       icon: const Icon(Icons.close),
//                       onPressed: () => Navigator.pop(context),
//                     )
//                   ],
//                 ),
//
//                 const SizedBox(height: 10),
//
//                 /// CALENDAR
//                 CalendarDatePicker(
//                   initialDate: selectedDate,
//                   firstDate: DateTime.now(),
//                   lastDate: DateTime.now().add(const Duration(days: 3650)),
//                   onDateChanged: (date) {
//                     setState(() {
//                       selectedDate = date;
//                     });
//                   },
//                 ),
//
//                 const SizedBox(height: 10),
//
//                 /// ACTION BUTTON
//                 SizedBox(
//                   width: double.infinity,
//                   child: ElevatedButton(
//                     onPressed: () {
//                       Navigator.pop(context, selectedDate);
//                     },
//                     child: const Text("Confirm"),
//                   ),
//                 ),
//               ],
//             ),
//           );
//         },
//       );
//     },
//   );
// }
