import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../services/api_service.dart';
import '../models/models.dart';
import 'bulk_import_dialog.dart';

class TrainersScreen extends StatefulWidget {
  const TrainersScreen({super.key});

  @override
  State<TrainersScreen> createState() => _TrainersScreenState();
}

class _TrainersScreenState extends State<TrainersScreen> {
  late Future<TrainersResponse> trainersFuture;
  late Future<MembersResponse> membersFuture;

  @override
  void initState() {
    super.initState();
    trainersFuture = ApiService().getTrainers();
    membersFuture = ApiService().getMembers(limit: 200);
  }

  void _reload() {
    setState(() {
      trainersFuture = ApiService().getTrainers();
      membersFuture = ApiService().getMembers(limit: 200);
    });
  }

  Future<void> _showImportDialog() async {
    await showTrainersImportDialog(
      context,
      onSuccess: _reload,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Trainers'),
        actions: [
          IconButton(
            icon: const Icon(Icons.upload_file_outlined),
            tooltip: 'Import from Excel / CSV',
            onPressed: _showImportDialog,
          ),
        ],
      ),
      body: FutureBuilder<TrainersResponse>(
        future: trainersFuture,
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
                  ElevatedButton(onPressed: _reload, child: const Text('Retry')),
                ],
              ),
            );
          }

          final trainers = snapshot.data?.trainers ?? [];

          if (trainers.isEmpty) {
            return Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(Icons.person_off_outlined, size: 64, color: Colors.grey[300]),
                  const SizedBox(height: 16),
                  Text('No trainers yet', style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 8),
                  Text('Tap + to add your first trainer',
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.grey)),
                ],
              ),
            );
          }

          return RefreshIndicator(
            onRefresh: () async => _reload(),
            child: ListView.builder(
              itemCount: trainers.length,
              padding: const EdgeInsets.all(12),
              itemBuilder: (context, index) {
                final trainer = trainers[index];
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
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                            decoration: BoxDecoration(
                              color: Colors.blue.withValues(alpha: 0.1),
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: Text(
                              '${trainer.assignedMembersCount} members assigned',
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
                            tooltip: 'Assign Members',
                            onPressed: () => _showAssignMembersDialog(context, trainer),
                          ),
                          IconButton(
                            icon: const Icon(Icons.edit_outlined, color: Colors.blue),
                            tooltip: 'Edit Trainer',
                            onPressed: () => _showEditTrainerDialog(context, trainer),
                          ),
                          IconButton(
                            icon: const Icon(Icons.delete_outline, color: Colors.red),
                            tooltip: 'Remove Trainer',
                            onPressed: () => _confirmDelete(context, trainer),
                          ),
                        ],
                      ),
                    ),
                  ),
                );
              },
            ),
          );
        },
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _showAddTrainerDialog(context),
        icon: const Icon(Icons.person_add),
        label: const Text('Add Trainer'),
      ),
    );
  }

  void _showEditTrainerDialog(BuildContext context, Trainer trainer) {
    final nameController = TextEditingController(text: trainer.name);
    final phoneController = TextEditingController(text: trainer.phone);

    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Edit Trainer'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: nameController,
              decoration: const InputDecoration(
                  labelText: 'Full Name *', prefixIcon: Icon(Icons.person)),
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
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () async {
              if (nameController.text.isEmpty || phoneController.text.isEmpty) {
                ScaffoldMessenger.of(ctx).showSnackBar(
                    const SnackBar(content: Text('Name and phone are required')));
                return;
              }
              final messenger = ScaffoldMessenger.of(context);
              final dialogMessenger = ScaffoldMessenger.of(ctx);
              final nav = Navigator.of(ctx);
              try {
                await ApiService().updateTrainer(
                  trainerId: trainer.id,
                  name: nameController.text,
                  phone: phoneController.text,
                );
                if (mounted) {
                  nav.pop();
                  _reload();
                  messenger.showSnackBar(
                      const SnackBar(content: Text('Trainer updated')));
                }
              } catch (e) {
                if (mounted) {
                  dialogMessenger
                      .showSnackBar(SnackBar(content: Text('Error: $e')));
                }
              }
            },
            child: const Text('Save'),
          ),
        ],
      ),
    );
  }

  void _showAssignMembersDialog(BuildContext context, Trainer trainer) {
    // Will be populated once members load
    final Set<String> selectedMemberIds = {};

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Assign Members'),
              Text('to ${trainer.name}',
                  style: Theme.of(ctx).textTheme.bodySmall?.copyWith(color: Colors.grey)),
            ],
          ),
          content: SizedBox(
            width: double.maxFinite,
            child: FutureBuilder<List<dynamic>>(
              future: Future.wait([membersFuture, trainersFuture]),
              builder: (context, snapshot) {
                if (snapshot.connectionState == ConnectionState.waiting) {
                  return const Center(child: CircularProgressIndicator());
                }
                final members = (snapshot.data?[0] as MembersResponse?)?.members ?? [];
                final trainers = (snapshot.data?[1] as TrainersResponse?)?.trainers ?? [];
                final trainerMap = {for (final t in trainers) t.id: t.name};

                // Pre-populate on first load
                if (selectedMemberIds.isEmpty) {
                  for (final m in members) {
                    if (m.assignedTrainerId == trainer.id) {
                      selectedMemberIds.add(m.id);
                    }
                  }
                }

                if (members.isEmpty) {
                  return const Text('No members found');
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
                        'Check to assign, uncheck to unassign. Each member can only belong to one trainer.',
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
                          final isAssignedToOther = member.assignedTrainerId != null &&
                              member.assignedTrainerId != trainer.id;
                          final otherTrainerName = isAssignedToOther
                              ? trainerMap[member.assignedTrainerId] ?? 'Another trainer'
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
                                  Text('Assigned to: $otherTrainerName',
                                      style: TextStyle(fontSize: 11, color: Colors.grey[400])),
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
                      final messenger = ScaffoldMessenger.of(context);
                      final nav = Navigator.of(ctx);
                      final count = selectedMemberIds.length;
                      final trainerName = trainer.name;
                      try {
                        await ApiService().assignMembersToTrainer(
                          trainerId: trainer.id,
                          memberIds: selectedMemberIds.toList(),
                        );
                        if (mounted) {
                          nav.pop();
                          _reload();
                          messenger.showSnackBar(
                            SnackBar(
                              content: Text(
                                  '$count member(s) assigned to $trainerName'),
                            ),
                          );
                        }
                      } catch (e) {
                        if (mounted) {
                          messenger.showSnackBar(SnackBar(content: Text('Error: $e')));
                        }
                      }
                    },
              child: const Text('Save'),
            ),
          ],
        ),
      ),
    );
  }

  void _confirmDelete(BuildContext context, Trainer trainer) {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove Trainer'),
        content: Text('Remove ${trainer.name} from your gym?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
                backgroundColor: Colors.red, foregroundColor: Colors.white),
            onPressed: () async {
              Navigator.pop(ctx);
              final messenger = ScaffoldMessenger.of(context);
              try {
                await ApiService().deleteTrainer(trainer.id);
                if (mounted) {
                  _reload();
                  messenger.showSnackBar(const SnackBar(content: Text('Trainer removed')));
                }
              } catch (e) {
                if (mounted) {
                  messenger.showSnackBar(SnackBar(content: Text('Error: $e')));
                }
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

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: const Text('Add Trainer'),
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
                  controller: phoneController,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(
                      labelText: 'Phone *', prefixIcon: Icon(Icons.phone)),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: emailController,
                  keyboardType: TextInputType.emailAddress,
                  decoration: const InputDecoration(
                      labelText: 'Email (login) *', prefixIcon: Icon(Icons.email)),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: passwordController,
                  obscureText: obscurePassword,
                  decoration: InputDecoration(
                    labelText: 'Password *',
                    prefixIcon: const Icon(Icons.lock),
                    suffixIcon: IconButton(
                      icon: Icon(obscurePassword
                          ? Icons.visibility_off
                          : Icons.visibility),
                      onPressed: () =>
                          setDialogState(() => obscurePassword = !obscurePassword),
                    ),
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  'Min 8 chars • 1 uppercase • 1 number • 1 special character\nTrainer logs in with this email + password',
                  style: Theme.of(ctx).textTheme.bodySmall?.copyWith(color: Colors.grey),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
            ElevatedButton(
              onPressed: () async {
                if (nameController.text.isEmpty ||
                    phoneController.text.isEmpty ||
                    emailController.text.isEmpty ||
                    passwordController.text.isEmpty) {
                  ScaffoldMessenger.of(ctx).showSnackBar(
                      const SnackBar(content: Text('Please fill all fields')));
                  return;
                }
                final pwd = passwordController.text;
                if (pwd.length < 8) {
                  ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(
                      content: Text('Password must be at least 8 characters'),
                      backgroundColor: Colors.red));
                  return;
                }
                if (!RegExp(r'[A-Z]').hasMatch(pwd)) {
                  ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(
                      content: Text('Password must contain at least 1 uppercase letter'),
                      backgroundColor: Colors.red));
                  return;
                }
                if (!RegExp(r'[0-9]').hasMatch(pwd)) {
                  ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(
                      content: Text('Password must contain at least 1 number'),
                      backgroundColor: Colors.red));
                  return;
                }
                if (!RegExp(r'[^A-Za-z0-9]').hasMatch(pwd)) {
                  ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(
                      content: Text('Password must contain at least 1 special character'),
                      backgroundColor: Colors.red));
                  return;
                }
                final messenger = ScaffoldMessenger.of(context);
                final nav = Navigator.of(ctx);
                final name = nameController.text;
                final email = emailController.text;
                try {
                  await ApiService().createTrainer(
                    name: name,
                    phone: phoneController.text,
                    email: email,
                    password: passwordController.text,
                  );
                  if (mounted) {
                    nav.pop();
                    _reload();
                    messenger.showSnackBar(
                      SnackBar(
                        content: Text('$name added. They can login with $email'),
                        duration: const Duration(seconds: 4),
                      ),
                    );
                  }
                } catch (e) {
                  if (mounted) {
                    messenger.showSnackBar(SnackBar(content: Text('Error: $e')));
                  }
                }
              },
              child: const Text('Add Trainer'),
            ),
          ],
        ),
      ),
    );
  }
}
