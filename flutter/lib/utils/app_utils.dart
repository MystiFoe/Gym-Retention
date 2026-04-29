import 'package:flutter/material.dart';

class AppUtils {
  static GlobalKey<ScaffoldMessengerState> messengerKey = GlobalKey<ScaffoldMessengerState>();
  static final GlobalKey<NavigatorState> navigatorKey = GlobalKey<NavigatorState>();

  static String? validatePhoneNumber(String? value) {
    String? phone = value?.replaceAll(" ", "");

    if (phone!.isEmpty) return "Please Enter 10 digit Mobile Number";

    if (!RegExp(r'^[0-9]+$').hasMatch(phone)) {
      return "Please Enter Valid Number start with 6,7,8,9";
    }
    if (!RegExp(r'^[6-9]').hasMatch(phone)) {
      return "Please Enter Valid Number";
    }
    if (phone.length > 10) {
      return "Please Enter your Phone number";
    }if (phone.length < 10) {
      return "Please Enter 10 digit Mobile Number";
    }

    return null;
  }

  static String? validateName(String? value) {
    if (value == null || value.trim().isEmpty) {
      return "Name is required";
    }

    if (value.trim().length < 3) {
      return "Name must have at least 3 letters";
    }

    return null;
  }
  static String? validateEmail(String? value) {
    String? email = value?.trim();

    if (email == null || email.isEmpty) {
      return "Please Enter Email Address";
    }

    // Basic format check
    if (!RegExp(r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$')
        .hasMatch(email)) {
      return "Please Enter Valid Email Address";
    }

    // Optional: prevent consecutive dots
    if (email.contains('..')) {
      return "Email should not contain consecutive dots";
    }

    // Optional: check length
    if (email.length > 254) {
      return "Email is too long";
    }

    return null;
  }
  static String? validatePlanFee(String? value) {
    String? feeStr = value?.trim();

    if (feeStr == null || feeStr.isEmpty) {
      return "Please Enter Plan Fee";
    }

    // Check only numbers (optional: allow decimal)
    if (!RegExp(r'^\d+(\.\d+)?$').hasMatch(feeStr)) {
      return "Please Enter Valid Amount";
    }

    final fee = double.tryParse(feeStr);

    if (fee == null) {
      return "Invalid Fee Amount";
    }

    if (fee <= 0) {
      return "Fee must be greater than 0";
    }

    if (fee > 1000000) {
      return "Fee is too large";
    }

    return null;
  }
  static String? validatePassword(String value) {
    final password = value.trim();

    if (password.isEmpty) return "Please enter password";

    if (password.length < 8) {
      return "Minimum 8 characters required";
    }

    if (!RegExp(r'[A-Z]').hasMatch(password)) {
      return "Add at least 1 uppercase letter";
    }

    if (!RegExp(r'[a-z]').hasMatch(password)) {
      return "Add at least 1 lowercase letter";
    }

    if (!RegExp(r'[0-9]').hasMatch(password)) {
      return "Add at least 1 number";
    }

    if (!RegExp(r'[!@#$%^&*(),.?":{}|<>]').hasMatch(password)) {
      return "Add at least 1 special character";
    }

    return null;
  }

}