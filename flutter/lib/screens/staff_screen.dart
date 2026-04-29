import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:gym_fitness_app/utils/app_routes.dart';
import 'package:gym_fitness_app/utils/app_utils.dart';
import 'package:gym_fitness_app/utils/appui_helper.dart';
import '../services/api_service.dart';
import '../models/models.dart';

class TrainersScreen extends StatefulWidget {
  const TrainersScreen({super.key});

  @override
  State<TrainersScreen> createState() => _TrainersScreenState();
}

class _TrainersScreenState extends State<TrainersScreen> {
  // ── Infinite scroll state ────────────────────────────────────────────────
  final ScrollController _scrollController = ScrollController();
  final List<Staff> _trainers = [];
  int _currentPage = 1;
  int _totalPages = 1;
  bool _isLoading = false;
  bool _isLoadingMore = false;
  String? _error;

  // Members loaded once for the Assign dialog
  late Future<CustomersResponse> membersFuture;

  @override
  void initState() {
    super.initState();
    membersFuture = ApiService().getCustomers(limit: 200);
    _scrollController.addListener(_onScroll);
    _loadTrainers(refresh: true);
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
        _loadTrainers();
      }
    }
  }

  Future<void> _loadTrainers({bool refresh = false}) async {
    if (!refresh && (_isLoading || _isLoadingMore)) return;
    if (!refresh && _currentPage > _totalPages) return;

    setState(() {
      if (refresh) {
        _isLoading = true;
        _trainers.clear();
        _currentPage = 1;
        _totalPages = 1;
        _error = null;
      } else {
        _isLoadingMore = true;
      }
    });

    try {
      final response = await ApiService().getStaff(page: _currentPage);
      if (mounted) {
        setState(() {
          _trainers.addAll(response.staff);
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
              .addPostFrameCallback((_) => context.go('/login'));
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

  // Keep _reload for backward-compat with dialog callbacks
  void _reload() => _loadTrainers(refresh: true);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Staff')),
      body: _buildTrainerList(),

      // body: FutureBuilder<StaffResponse>(
      //   future: trainersFuture,
      //   builder: (context, snapshot) {
      //     if (snapshot.connectionState == ConnectionState.waiting) {
      //       return const Center(child: CircularProgressIndicator());
      //     }
      //
      //     if (snapshot.hasError) {
      //       final err = snapshot.error.toString().toLowerCase();
      //       if (err.contains('session') || err.contains('unauthorized') || err.contains('token') || err.contains('401')) {
      //         WidgetsBinding.instance.addPostFrameCallback((_) => context.go('/login'));
      //         return const Center(child: CircularProgressIndicator());
      //       }
      //       return Center(
      //         child: Column(
      //           mainAxisAlignment: MainAxisAlignment.center,
      //           children: [
      //             Text('Error: ${snapshot.error}'),
      //             const SizedBox(height: 12),
      //             ElevatedButton(onPressed: _reload, child: const Text('Retry')),
      //           ],
      //         ),
      //       );
      //     }
      //
      //     final trainers = snapshot.data?.staff ?? [];
      //
      //     if (trainers.isEmpty) {
      //       return Center(
      //         child: Column(
      //           mainAxisAlignment: MainAxisAlignment.center,
      //           children: [
      //             Icon(Icons.person_off_outlined, size: 64, color: Colors.grey[300]),
      //             const SizedBox(height: 16),
      //             Text('No trainers yet', style: Theme.of(context).textTheme.titleMedium),
      //             const SizedBox(height: 8),
      //             Text('Tap + to add your first trainer',
      //                 style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.grey)),
      //           ],
      //         ),
      //       );
      //     }
      //
      //     return RefreshIndicator(
      //       onRefresh: () async => _reload(),
      //       child: ListView.builder(
      //         itemCount: trainers.length,
      //         padding: const EdgeInsets.all(12),
      //         itemBuilder: (context, index) {
      //           final trainer = trainers[index];
      //           return Card(
      //             margin: const EdgeInsets.only(bottom: 10),
      //             shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      //             child: Padding(
      //               padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
      //               child: ListTile(
      //                 leading: CircleAvatar(
      //                   backgroundColor: const Color(0xFF2196F3).withValues(alpha: 0.15),
      //                   child: Text(
      //                     trainer.name[0].toUpperCase(),
      //                     style: const TextStyle(
      //                         color: Color(0xFF2196F3), fontWeight: FontWeight.bold),
      //                   ),
      //                 ),
      //                 title: Text(trainer.name,
      //                     style: const TextStyle(fontWeight: FontWeight.bold)),
      //                 subtitle: Column(
      //                   crossAxisAlignment: CrossAxisAlignment.start,
      //                   children: [
      //                     Text(trainer.phone),
      //                     Text(trainer.email,
      //                         style: Theme.of(context)
      //                             .textTheme
      //                             .bodySmall
      //                             ?.copyWith(color: Colors.grey)),
      //                     const SizedBox(height: 4),
      //                     Container(
      //                       padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      //                       decoration: BoxDecoration(
      //                         color: Colors.blue.withValues(alpha: 0.1),
      //                         borderRadius: BorderRadius.circular(8),
      //                       ),
      //                       child: Text(
      //                         '${trainer.assignedCustomersCount} customers assigned',
      //                         style: const TextStyle(fontSize: 11, color: Colors.blue),
      //                       ),
      //                     ),
      //                   ],
      //                 ),
      //                 isThreeLine: true,
      //                 trailing: Row(
      //                   mainAxisSize: MainAxisSize.min,
      //                   children: [
      //                     IconButton(
      //                       icon: const Icon(Icons.group_add, color: Colors.green),
      //                       tooltip: 'Assign Customers',
      //                       onPressed: () => _showAssignMembersDialog(context, trainer),
      //                     ),
      //                     IconButton(
      //                       icon: const Icon(Icons.edit_outlined, color: Colors.blue),
      //                       tooltip: 'Edit Staff',
      //                       onPressed: () => _showEditTrainerDialog(context, trainer),
      //                     ),
      //                     IconButton(
      //                       icon: const Icon(Icons.delete_outline, color: Colors.red),
      //                       tooltip: 'Remove Staff',
      //                       onPressed: () {
      //                         if (trainer.assignedCustomersCount >= 1) {
      //                           AppUiHelper().showModernSnackBar(context, message: "Staff has assigned members. Cannot delete.",isError: true);
      //                           // ScaffoldMessenger.of(context)
      //                           //   ..clearSnackBars()
      //                           //   ..showSnackBar(
      //                           //     const SnackBar(
      //                           //       content: Text(
      //                           //         'Staff has assigned members. Cannot delete.',
      //                           //       ),
      //                           //       backgroundColor: Colors.red, // ✅ error color
      //                           //       duration: Duration(seconds: 2),
      //                           //     ),
      //                           //   );
      //                         } else {
      //                           _confirmDelete(context, trainer);
      //                         }
      //                       },
      //                     ),
      //                   ],
      //                 ),
      //               ),
      //             ),
      //           );
      //         },
      //       ),
      //     );
      //   },
      // ),
      floatingActionButton: FloatingActionButton.extended(
        heroTag: 'trainer_fab',
        onPressed: () => _showAddTrainerDialog(context),
        icon: const Icon(Icons.person_add),
        label: const Text('Add Staff'),
      ),
    );
  }

  Widget _buildTrainerList() {
    if (_isLoading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
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
    if (_trainers.isEmpty) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.person_off_outlined, size: 64, color: Colors.grey[300]),
            const SizedBox(height: 16),
            Text('No staff yet', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            Text('Tap + to add your first staff member',
                style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.grey)),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: () => _loadTrainers(refresh: true),
      child: ListView.builder(
        controller: _scrollController,
        itemCount: _trainers.length + (_isLoadingMore ? 1 : 0),
        padding: const EdgeInsets.all(12),
        itemBuilder: (context, index) {
          if (index == _trainers.length) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(16),
                child: CircularProgressIndicator(),
              ),
            );
          }
          final trainer = _trainers[index];
          return Card(
            margin: const EdgeInsets.only(bottom: 10),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
              child: ListTile(
                leading: CircleAvatar(
                  backgroundColor: const Color(0xFF2196F3).withValues(alpha: 0.15),
                  child: Text(
                    trainer.name[0].toUpperCase(),
                    style: const TextStyle(
                        color: Color(0xFF2196F3), fontWeight: FontWeight.bold),
                  ),
                ),
                title: Text(trainer.name,
                    style: const TextStyle(fontWeight: FontWeight.bold)),
                subtitle: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(trainer.phone),
                    Text(trainer.email,
                        style: Theme.of(context)
                            .textTheme
                            .bodySmall
                            ?.copyWith(color: Colors.grey)),
                    const SizedBox(height: 4),
                    Container(
                      padding:
                          const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                      decoration: BoxDecoration(
                        color: Colors.blue.withValues(alpha: 0.1),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        '${trainer.assignedCustomersCount} customers assigned',
                        style: const TextStyle(fontSize: 11, color: Colors.blue),
                      ),
                    ),
                  ],
                ),
                isThreeLine: true,
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    IconButton(
                      icon: const Icon(Icons.group_add, color: Colors.green),
                      tooltip: 'Assign Customers',
                      onPressed: () => _showAssignMembersDialog(context, trainer),
                    ),
                    IconButton(
                      icon: const Icon(Icons.edit_outlined, color: Colors.blue),
                      tooltip: 'Edit Staff',
                      onPressed: () => _showEditTrainerDialog(context, trainer),
                    ),
                    IconButton(
                      icon: const Icon(Icons.delete_outline, color: Colors.red),
                      tooltip: 'Remove Staff',
                      onPressed: () {
                        if (trainer.assignedCustomersCount >= 1) {
                          AppUiHelper().showModernSnackBar(
                            context,
                            message: 'Staff has assigned customers. Cannot delete.',
                            isError: true,
                          );
                        } else {
                          _confirmDelete(context, trainer);
                        }
                      },
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  void _showEditTrainerDialog(BuildContext context, Staff trainer) {
    final nameController  = TextEditingController(text: trainer.name);
    final phoneController = TextEditingController(text: trainer.phone);
    final emailController = TextEditingController(text: trainer.email);

    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Edit Staff'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: nameController,
                decoration: const InputDecoration(
                    labelText: 'Full Name *', prefixIcon: Icon(Icons.person)),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: emailController,
                keyboardType: TextInputType.emailAddress,
                decoration: const InputDecoration(
                    labelText: 'Email (Login ID)', prefixIcon: Icon(Icons.email)),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: phoneController,
                keyboardType: TextInputType.phone,
                decoration: const InputDecoration(
                    labelText: 'Phone *', prefixIcon: Icon(Icons.phone)),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () async {
              if (nameController.text.isEmpty || phoneController.text.isEmpty) {
                AppUiHelper().showModernSnackBar(context, message: 'Name and phone are required');
                return;
              }
              try {
                await ApiService().updateStaff(
                  staffId: trainer.id,
                  name: nameController.text,
                  phone: phoneController.text,
                  email: emailController.text.trim().isNotEmpty ? emailController.text.trim() : null,
                );
                if (!context.mounted) return;
                AppRoutes.pop();
                _reload();
                AppUiHelper().showModernSnackBar(context, message: 'Staff updated');
              } catch (e) {
                if (!context.mounted) return;
                AppUiHelper().showModernSnackBar(context, message: e.toString(), isError: true);
              }
            },
            child: const Text('Save'),
          ),
        ],
      ),
    );
  }
  void _showAssignMembersDialog(BuildContext context, Staff trainer) {
    final Set<String> selectedMemberIds = {};
    bool isInitialized = false;

    /// ✅ CACHE FUTURE (fix flicker)
    final futureData = Future.wait([
      membersFuture,
      ApiService().getStaff(limit: 100),
    ]);

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Assign Customers'),
              Text('to ${trainer.name}',
                  style: Theme.of(ctx).textTheme.bodySmall?.copyWith(color: Colors.grey)),
            ],
          ),
          content: ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: double.maxFinite,
              maxHeight: MediaQuery.of(ctx).size.height * 0.5,
            ),
            child: FutureBuilder<List<dynamic>>(
              future: futureData,
              builder: (context, snapshot) {
                if (snapshot.connectionState == ConnectionState.waiting) {
                  return const SizedBox(
                    height: 80,
                    child: Center(child: CircularProgressIndicator()),
                  );
                }

                final members = (snapshot.data?[0] as CustomersResponse?)?.customers ?? [];
                final trainers = (snapshot.data?[1] as StaffResponse?)?.staff ?? [];
                final trainerMap = {for (final t in trainers) t.id: t.name};

                /// ✅ Pre-populate ONCE (safe)
                // if (selectedMemberIds.isEmpty) {
                //   for (final m in members) {
                //     if (m.assignedStaffId == trainer.id) {
                //       selectedMemberIds.add(m.id);
                //     }
                //   }
                // }
                if (!isInitialized) {
                  for (final m in members) {
                    if (m.assignedStaffId == trainer.id) {
                      selectedMemberIds.add(m.id);
                    }
                  }
                  isInitialized = true;
                }

                if (members.isEmpty) {
                  return const Text('No customers found');
                }

                return Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: Colors.blue[50],
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: const Text(
                        'Check to assign, uncheck to unassign. Each customer can only belong to one staff member.',
                        style: TextStyle(fontSize: 11, color: Colors.blue),
                      ),
                    ),
                    const SizedBox(height: 8),
                    Flexible(
                      child: ListView.builder(
                        shrinkWrap: true,
                        itemCount: members.length,
                        itemBuilder: (context, index) {
                          final member = members[index];

                          final isAssignedToOther =
                              member.assignedStaffId != null &&
                                  member.assignedStaffId != trainer.id;

                          final otherTrainerName = isAssignedToOther
                              ? trainerMap[member.assignedStaffId] ?? 'Another staff'
                              : null;

                          final isSelected = selectedMemberIds.contains(member.id);

                          return CheckboxListTile(
                            value: isSelected,
                            enabled: !isAssignedToOther,
                            title: Text(
                              member.name,
                              style: TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w500,
                                color: isAssignedToOther ? Colors.grey[400] : null,
                              ),
                            ),
                            subtitle: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  member.phone,
                                  style: TextStyle(
                                    fontSize: 12,
                                    color: isAssignedToOther ? Colors.grey[400] : null,
                                  ),
                                ),
                                if (isAssignedToOther)
                                  Text(
                                    'Assigned to: $otherTrainerName (staff)',
                                    style: TextStyle(fontSize: 11, color: Colors.grey[400]),
                                  ),
                              ],
                            ),
                            isThreeLine: isAssignedToOther,
                            dense: true,
                            onChanged: isAssignedToOther
                                ? null
                                : (val) {
                              setDialogState(() {
                                if (val == true) {
                                  selectedMemberIds.add(member.id);
                                } else {
                                  selectedMemberIds.remove(member.id);
                                }
                              });
                            },
                          );
                        },
                      ),
                    ),
                  ],
                );
              },
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
            ElevatedButton(
              onPressed: () async {
                final count = selectedMemberIds.length;
                final trainerName = trainer.name;
                try {
                  await ApiService().assignCustomersToStaff(
                    staffId: trainer.id,
                    customerIds: selectedMemberIds.toList(),
                  );
                  if (!context.mounted) return;
                  AppRoutes.pop();
                  setState(() {
                    membersFuture = ApiService().getCustomers(limit: 200);
                  });
                  _reload();
                  AppUiHelper().showModernSnackBar(
                    context,
                    message: '$count customer(s) assigned to $trainerName',
                  );
                } catch (e) {
                  if (!context.mounted) return;
                  AppUiHelper().showModernSnackBar(
                    context,
                    message: e.toString(),
                    isError: true,
                  );
                }
              },
              child: const Text('Save'),
            ),
          ],
        ),
      ),
    );
  }


  // void _showAssignMembersDialog(BuildContext context, Staff trainer) {
  //   // Will be populated once members load
  //   final Set<String> selectedMemberIds = {};
  //
  //   showDialog(
  //     context: context,
  //     builder: (ctx) => StatefulBuilder(
  //       builder: (ctx, setDialogState) => AlertDialog(
  //         title: Column(
  //           crossAxisAlignment: CrossAxisAlignment.start,
  //           children: [
  //             const Text('Assign Members'),
  //             Text('to ${trainer.name}',
  //                 style: Theme.of(ctx).textTheme.bodySmall?.copyWith(color: Colors.grey)),
  //           ],
  //         ),
  //         content: SizedBox(
  //           width: double.maxFinite,
  //           child: FutureBuilder<List<dynamic>>(
  //             future: Future.wait([membersFuture, trainersFuture]),
  //             builder: (context, snapshot) {
  //               if (snapshot.connectionState == ConnectionState.waiting) {
  //                 return const Center(child: CircularProgressIndicator());
  //               }
  //               final members = (snapshot.data?[0] as CustomersResponse?)?.customers ?? [];
  //               final trainers = (snapshot.data?[1] as StaffResponse?)?.staff ?? [];
  //               final trainerMap = {for (final t in trainers) t.id: t.name};
  //
  //               // Pre-populate on first load
  //               if (selectedMemberIds.isEmpty) {
  //                 for (final m in members) {
  //                   if (m.assignedStaffId == trainer.id) {
  //                     selectedMemberIds.add(m.id);
  //                   }
  //                 }
  //               }
  //
  //               if (members.isEmpty) {
  //                 return const Text('No members found');
  //               }
  //               return Column(
  //                 mainAxisSize: MainAxisSize.min,
  //                 children: [
  //                   Container(
  //                     padding: const EdgeInsets.all(8),
  //                     decoration: BoxDecoration(
  //                       color: Colors.blue[50],
  //                       borderRadius: BorderRadius.circular(8),
  //                     ),
  //                     child: const Text(
  //                       'Check to assign, uncheck to unassign. Each member can only belong to one trainer.',
  //                       style: TextStyle(fontSize: 11, color: Colors.blue),
  //                     ),
  //                   ),
  //                   const SizedBox(height: 8),
  //                   Flexible(
  //                     child: ListView.builder(
  //                       shrinkWrap: true,
  //                       itemCount: members.length,
  //                       itemBuilder: (context, index) {
  //                         final member = members[index];
  //                         final isAssignedToOther = member.assignedStaffId != null &&
  //                             member.assignedStaffId != trainer.id;
  //                         final otherTrainerName = isAssignedToOther
  //                             ? trainerMap[member.assignedStaffId] ?? 'Another trainer'
  //                             : null;
  //                         final isSelected = selectedMemberIds.contains(member.id);
  //
  //                         return CheckboxListTile(
  //                           value: isSelected,
  //                           enabled: !isAssignedToOther,
  //                           title: Text(
  //                             member.name,
  //                             style: TextStyle(
  //                               fontSize: 14,
  //                               fontWeight: FontWeight.w500,
  //                               color: isAssignedToOther ? Colors.grey[400] : null,
  //                             ),
  //                           ),
  //                           subtitle: Column(
  //                             crossAxisAlignment: CrossAxisAlignment.start,
  //                             children: [
  //                               Text(
  //                                 member.phone,
  //                                 style: TextStyle(
  //                                   fontSize: 12,
  //                                   color: isAssignedToOther ? Colors.grey[400] : null,
  //                                 ),
  //                               ),
  //                               if (isAssignedToOther)
  //                                 Text('Assigned to: $otherTrainerName',
  //                                     style: TextStyle(fontSize: 11, color: Colors.grey[400])),
  //                             ],
  //                           ),
  //                           isThreeLine: isAssignedToOther,
  //                           dense: true,
  //                           onChanged: isAssignedToOther
  //                               ? null
  //                               : (val) {
  //                                   setDialogState(() {
  //                                     if (val == true) {
  //                                       selectedMemberIds.add(member.id);
  //                                     } else {
  //                                       selectedMemberIds.remove(member.id);
  //                                     }
  //                                   });
  //                                 },
  //                         );
  //                       },
  //                     ),
  //                   ),
  //                 ],
  //               );
  //             },
  //           ),
  //         ),
  //         actions: [
  //           TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
  //           ElevatedButton(
  //             onPressed: () async {
  //                     final messenger = ScaffoldMessenger.of(context);
  //                     final count = selectedMemberIds.length;
  //                     final trainerName = trainer.name;
  //                     try {
  //                       await ApiService().assignCustomersToStaff(
  //                         staffId: trainer.id,
  //                         customerIds: selectedMemberIds.toList(),
  //                       );
  //                       if (mounted) {
  //                         Navigator.pop(ctx);
  //                         _reload();
  //                         AppUiHelper().showModernSnackBar(context, message: '$count member(s) assigned to $trainerName');
  //
  //                         // messenger.showSnackBar(
  //                         //   SnackBar(
  //                         //     content: Text(
  //                         //         '$count member(s) assigned to $trainerName'),
  //                         //   ),
  //                         // );
  //                       }
  //                     } catch (e) {
  //                       if (mounted) {
  //                         AppUiHelper().showModernSnackBar(context, message: 'something went wrong',isError: true);
  //
  //                         // messenger.showSnackBar(SnackBar(content: Text('Error: $e')));
  //                       }
  //                     }
  //                   },
  //             child: const Text('Save'),
  //           ),
  //         ],
  //       ),
  //     ),
  //   );
  // }

  void _confirmDelete(BuildContext context, Staff trainer) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove Staff'),
        content: Text('Remove ${trainer.name} from your business?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
                backgroundColor: Colors.red, foregroundColor: Colors.white),
            onPressed: () async {
              AppRoutes.pop();
              try {
                await ApiService().deleteStaff(trainer.id);
                if (!context.mounted) return;
                _reload();
                AppUiHelper().showModernSnackBar(context, message: 'Staff removed');
              } catch (e) {
                if (!context.mounted) return;
                AppUiHelper().showModernSnackBar(context, message: e.toString(), isError: true);
              }
            },
            child: const Text('Remove'),
          ),
        ],
      ),
    );
  }
  void _showAddTrainerDialog(BuildContext context) {
    final nameController = TextEditingController();
    final phoneController = TextEditingController();
    final emailController = TextEditingController();
    final passwordController = TextEditingController();

    bool obscurePassword = true;

    String? nameError;
    String? phoneError;
    String? emailError;
    String? passwordError;

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: const Text('Add Staff'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [

                /// 🔹 Name
                TextFormField(
                  controller: nameController,
                  decoration: InputDecoration(
                    labelText: 'Full Name *',
                    prefixIcon: const Icon(Icons.person),
                    errorText: nameError,
                  ),
                  onChanged: (v) {
                    setDialogState(() {
                      nameError = AppUtils.validateName(v);
                    });
                  },
                ),

                const SizedBox(height: 12),

                /// 🔹 Phone
                TextFormField(
                  controller: phoneController,
                  keyboardType: TextInputType.phone,
                  decoration: InputDecoration(
                    labelText: 'Phone *',
                    prefixIcon: const Icon(Icons.phone),
                    errorText: phoneError,
                  ),
                  onChanged: (v) {
                    setDialogState(() {
                      phoneError = AppUtils.validatePhoneNumber(v);
                    });
                  },
                ),

                const SizedBox(height: 12),

                /// 🔹 Email
                TextFormField(
                  controller: emailController,
                  keyboardType: TextInputType.emailAddress,
                  decoration: InputDecoration(
                    labelText: 'Email *',
                    prefixIcon: const Icon(Icons.email),
                    errorText: emailError,
                  ),
                  onChanged: (v) {
                    setDialogState(() {
                      emailError = AppUtils.validateEmail(v);
                    });
                  },
                ),

                const SizedBox(height: 12),

                /// 🔹 Password
                TextFormField(
                  controller: passwordController,
                  obscureText: obscurePassword,
                  decoration: InputDecoration(
                    labelText: 'Password *',
                    prefixIcon: const Icon(Icons.lock),
                    errorText: passwordError,
                    suffixIcon: IconButton(
                      icon: Icon(
                        obscurePassword
                            ? Icons.visibility_off
                            : Icons.visibility,
                      ),
                      onPressed: () {
                        setDialogState(() {
                          obscurePassword = !obscurePassword;
                        });
                      },
                    ),
                  ),
                  onChanged: (v) {
                    setDialogState(() {
                      passwordError = AppUtils.validatePassword(v);
                    });
                  },
                ),

                const SizedBox(height: 8),

                Text(
                  'Min 8 chars • 1 uppercase • 1 number • 1 special character',
                  style: Theme.of(ctx)
                      .textTheme
                      .bodySmall
                      ?.copyWith(color: Colors.grey),
                ),
              ],
            ),
          ),

          /// 🔹 Actions
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('Cancel'),
            ),

            ElevatedButton(
              onPressed: () async {

                /// 🔥 Final validation before submit
                setDialogState(() {
                  nameError = AppUtils.validateName(nameController.text);
                  phoneError = AppUtils.validatePhoneNumber(phoneController.text);
                  emailError = AppUtils.validateEmail(emailController.text);
                  passwordError = AppUtils.validatePassword(passwordController.text);
                });

                /// ❌ If any error → stop
                if (nameError != null ||
                    phoneError != null ||
                    emailError != null ||
                    passwordError != null) {
                  return;
                }

                final nav = Navigator.of(ctx);

                try {
                  await ApiService().createStaff(
                    name: nameController.text.trim(),
                    phone: phoneController.text.trim(),
                    email: emailController.text.trim(),
                    password: passwordController.text,
                  );

                  if (!context.mounted) return;
                  nav.pop();
                  _reload();
                  AppUiHelper().showModernSnackBar(context, message: 'Staff added successfully');
                } catch (e) {
                  if (!context.mounted) return;
                  AppUiHelper().showModernSnackBar(context, message: e.toString(), isError: true);
                }
              },
              child: const Text('Add Staff'),
            ),
          ],
        ),
      ),
    );
  }

  // void _showAddTrainerDialog(BuildContext context) {
  //   final nameController = TextEditingController();
  //   final phoneController = TextEditingController();
  //   final emailController = TextEditingController();
  //   final passwordController = TextEditingController();
  //   bool obscurePassword = true;
  //   final formKey = GlobalKey<FormState>();
  //
  //   String? nameError;
  //   String? phoneError;
  //   String? emailError;
  //   String? passWordError;
  //   showDialog(
  //     context: context,
  //     builder: (ctx) => StatefulBuilder(
  //       builder: (ctx, setDialogState) => AlertDialog(
  //         title: const Text('Add Staff'),
  //         content: SingleChildScrollView(
  //           child: Form(
  //             key: formKey,
  //             child: Column(
  //               mainAxisSize: MainAxisSize.min,
  //               children: [
  //                 TextFormField(
  //                   autovalidateMode: AutovalidateMode.onUserInteraction,
  //
  //                   controller: nameController,
  //                   decoration:  InputDecoration(
  //                       labelText: 'Full Name *', prefixIcon: Icon(Icons.person),errorText: nameError),
  //                   validator: (v) => AppUtils.validateName(v),
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
  //                   validator: (v) =>AppUtils.validatePhoneNumber(v),
  //                   onChanged: (v){
  //                     setDialogState((){
  //                       phoneError = AppUtils.validatePhoneNumber(v);
  //                     });
  //                   },
  //                   decoration:  InputDecoration(
  //                       labelText: 'Phone *', prefixIcon: Icon(Icons.phone),errorText: phoneError),
  //                 ),
  //                 const SizedBox(height: 12),
  //                 TextFormField(
  //                   autovalidateMode: AutovalidateMode.onUserInteraction,
  //
  //                   controller: emailController,
  //                   keyboardType: TextInputType.emailAddress,
  //                   validator: (v) => AppUtils.validateEmail(v),
  //                   onChanged: (v){
  //                     setDialogState((){
  //                       emailError = AppUtils.validateEmail(v);
  //                     });
  //                   },
  //                   decoration:  InputDecoration(
  //                       labelText: 'Email (login) *', prefixIcon: Icon(Icons.email),errorText: emailError),
  //                 ),
  //                 const SizedBox(height: 12),
  //                 TextFormField(
  //                   autovalidateMode: AutovalidateMode.onUserInteraction,
  //
  //                   controller: passwordController,
  //                   obscureText: obscurePassword,
  //                   decoration: InputDecoration(
  //                     labelText: 'Password *',
  //                     prefixIcon: const Icon(Icons.lock),
  //                     errorText: passWordError,
  //                     suffixIcon: IconButton(
  //                       icon: Icon(obscurePassword
  //                           ? Icons.visibility_off
  //                           : Icons.visibility),
  //                       onPressed: () =>
  //                           setDialogState(() => obscurePassword = !obscurePassword),
  //                     ),
  //                   ),
  //                   validator: (v) => AppUtils.validatePassword(v??""),
  //                   onChanged: (v){
  //                     setDialogState((){
  //                       passWordError = AppUtils.validatePassword(v);
  //                     });
  //                   },
  //                 ),
  //                 const SizedBox(height: 8),
  //                 Text(
  //                   'Min 8 chars • 1 uppercase • 1 number • 1 special character\nTrainer logs in with this email + password',
  //                   style: Theme.of(ctx).textTheme.bodySmall?.copyWith(color: Colors.grey),
  //                 ),
  //               ],
  //             ),
  //           ),
  //         ),
  //         actions: [
  //           TextButton(
  //               onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
  //           ElevatedButton(
  //             onPressed: () async {
  //               if (nameController.text.isEmpty ||
  //                   phoneController.text.isEmpty ||
  //                   emailController.text.isEmpty ||
  //                   passwordController.text.isEmpty) {
  //                 ScaffoldMessenger.of(ctx).showSnackBar(
  //                     const SnackBar(content: Text('Please fill all fields')));
  //                 return;
  //               }
  //               final pwd = passwordController.text;
  //               if (pwd.length < 8) {
  //                 ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(
  //                     content: Text('Password must be at least 8 characters'),
  //                     backgroundColor: Colors.red));
  //                 return;
  //               }
  //               if (!RegExp(r'[A-Z]').hasMatch(pwd)) {
  //                 ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(
  //                     content: Text('Password must contain at least 1 uppercase letter'),
  //                     backgroundColor: Colors.red));
  //                 return;
  //               }
  //               if (!RegExp(r'[0-9]').hasMatch(pwd)) {
  //                 ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(
  //                     content: Text('Password must contain at least 1 number'),
  //                     backgroundColor: Colors.red));
  //                 return;
  //               }
  //               if (!RegExp(r'[^A-Za-z0-9]').hasMatch(pwd)) {
  //                 ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(
  //                     content: Text('Password must contain at least 1 special character'),
  //                     backgroundColor: Colors.red));
  //                 return;
  //               }
  //               final messenger = ScaffoldMessenger.of(context);
  //               final nav = Navigator.of(ctx);
  //               final name = nameController.text;
  //               final email = emailController.text;
  //               try {
  //                 await ApiService().createStaff(
  //                   name: name,
  //                   phone: phoneController.text,
  //                   email: email,
  //                   password: passwordController.text,
  //                 );
  //                 if (mounted) {
  //                   nav.pop();
  //                   _reload();
  //                   messenger.showSnackBar(
  //                     SnackBar(
  //                       content: Text('$name added. They can login with $email'),
  //                       duration: const Duration(seconds: 4),
  //                     ),
  //                   );
  //                 }
  //               } catch (e) {
  //                 if (mounted) {
  //                   messenger.showSnackBar(SnackBar(content: Text('Error: $e')));
  //                 }
  //               }
  //             },
  //             child: const Text('Add Staff'),
  //           ),
  //         ],
  //       ),
  //     ),
  //   );
  // }
}
