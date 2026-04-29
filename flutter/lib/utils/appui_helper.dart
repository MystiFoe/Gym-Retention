import 'package:flutter/material.dart';

import 'app_utils.dart';

class AppUiHelper {
  static Future<T?> showCustomDialog<T>(Widget child,{bool barrier = false}) async {
    final context = AppUtils.navigatorKey.currentContext;
    if (context == null) return null;

    return showDialog<T>(
      context: context,
      barrierDismissible: barrier,
      builder: (BuildContext context) {
        return Material(
          type: MaterialType.transparency,
          child: child,
        );
      },
    );
  }
  void showModernSnackBar(
      BuildContext context, {
        required String message,
        bool isError = false,
      }) {
    final snackBar = SnackBar(
      content: Row(
        children: [
          Icon(
            isError ? Icons.error_outline : Icons.check_circle_outline,
            color: Colors.white,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              message,
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
        ],
      ),
      behavior: SnackBarBehavior.floating,
      backgroundColor: isError ? Colors.redAccent : Colors.blueAccent,
      elevation: 6,
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
      ),
      duration: const Duration(seconds: 2),
    );

    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(snackBar);
  }


}