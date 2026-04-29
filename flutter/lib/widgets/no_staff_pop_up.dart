import 'package:flutter/material.dart';
import 'package:gym_fitness_app/utils/app_routes.dart';

class NoTrainerPopUp extends StatelessWidget {
  final VoidCallback? onTap;

  const NoTrainerPopUp({super.key, this.onTap});

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('No Staff Yet'),
      content: const Text(
        'You need to add at least one staff member before adding customers. '
            'Go to the Staff section to add your first staff member.',
      ),
      actions: [
        TextButton(onPressed: () => AppRoutes.pop(), child: const Text('Cancel')),
        ElevatedButton(
          onPressed: () {
            onTap?.call();
          },
          child: const Text('Add Staff'),
        ),
      ],
    );
  }
}
