import 'package:flutter/material.dart';
import 'package:gym_fitness_app/models/models.dart';
import 'package:gym_fitness_app/services/api_service.dart';
import 'package:gym_fitness_app/utils/app_routes.dart';
import 'package:gym_fitness_app/utils/appui_helper.dart';

class MemberDeletePopup extends StatelessWidget {
  final Customer member;
  final VoidCallback? onTap;

  const MemberDeletePopup({
    super.key,
    required this.member,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Delete Customer'),
      content: Text(
        'Are you sure you want to remove ${member.name}? This cannot be undone.',
      ),
      actions: [
        TextButton(
          onPressed: () => AppRoutes.pop(),
          child: const Text('Cancel'),
        ),
        ElevatedButton(
          style: ElevatedButton.styleFrom(
            backgroundColor: Colors.red,
            foregroundColor: Colors.white,
          ),
          onPressed: () async {
            AppRoutes.pop();
            try {
              await ApiService().deleteCustomer(member.id);
              onTap?.call();
              if (!context.mounted) return;
              AppUiHelper().showModernSnackBar(context, message: "Customer removed");
            } catch (e) {
              if (!context.mounted) return;
              AppUiHelper().showModernSnackBar(context, message: e.toString(), isError: true);
            }
          },
          child: const Text('Delete'),
        ),
      ],
    );
  }
}
