class Validators {
  static String? validateEmail(String? value) {
    if (value?.isEmpty ?? true) return 'Email is required';
    final emailRegex = RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$');
    if (!emailRegex.hasMatch(value!)) return 'Invalid email format';
    return null;
  }

  static String? validatePhone(String? value) {
    if (value?.isEmpty ?? true) return 'Phone is required';
    if (value!.length < 10) return 'Phone must be at least 10 digits';
    return null;
  }

  static String? validatePassword(String? value) {
    if (value?.isEmpty ?? true) return 'Password is required';
    if (value!.length < 8) return 'Password must be at least 8 characters';
    return null;
  }

  static String? validateName(String? value) {
    if (value?.isEmpty ?? true) return 'Name is required';
    if (value!.length < 2) return 'Name must be at least 2 characters';
    return null;
  }
}
