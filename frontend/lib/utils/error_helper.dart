String friendlyError(Object error) {
  final msg = error.toString().toLowerCase();

  // Duplicate / unique constraint
  if (msg.contains('gyms_email_key') || (msg.contains('duplicate') && msg.contains('email'))) {
    return 'This gym email is already registered. Please use a different email.';
  }
  if (msg.contains('users_email_key') || (msg.contains('duplicate') && msg.contains('owner'))) {
    return 'This owner email is already in use. Please use a different email.';
  }
  if (msg.contains('gyms_phone_key') || (msg.contains('duplicate') && msg.contains('phone'))) {
    return 'This phone number is already registered.';
  }
  if (msg.contains('gyms_name_key') || (msg.contains('duplicate') && msg.contains('name'))) {
    return 'A gym with this name already exists.';
  }
  if (msg.contains('duplicate key') || msg.contains('unique constraint')) {
    return 'Some of the information you entered is already in use. Please check your details.';
  }

  // Auth errors
  if (msg.contains('invalid credentials') || msg.contains('invalid password') || msg.contains('wrong password')) {
    return 'Incorrect email or password. Please try again.';
  }
  if (msg.contains('user not found') || msg.contains('no user')) {
    return 'No account found with this email.';
  }
  if (msg.contains('session expired') || msg.contains('unauthorized') || msg.contains('token')) {
    return 'Your session has expired. Please log in again.';
  }
  if (msg.contains('account is inactive') || msg.contains('disabled')) {
    return 'Your account is inactive. Please contact support.';
  }

  // Rate limiting
  if (msg.contains('too many') || msg.contains('rate limit')) {
    return 'Too many attempts. Please wait a few minutes and try again.';
  }

  // Network / connection
  if (msg.contains('socketexception') || msg.contains('connection refused') || msg.contains('network')) {
    return 'Could not connect to server. Please check your internet connection.';
  }
  if (msg.contains('timeout')) {
    return 'Request timed out. Please try again.';
  }

  // Subscription
  if (msg.contains('subscription') || msg.contains('trial expired')) {
    return 'Your subscription has expired. Please renew to continue.';
  }

  // Validation errors from Zod (field: message format)
  if (msg.contains('field:') || msg.contains('required') || msg.contains('invalid email')) {
    return 'Please check your details and try again.';
  }

  // Generic server error
  if (msg.contains('500') || msg.contains('internal server')) {
    return 'Something went wrong on our end. Please try again shortly.';
  }

  // Strip "Exception:" prefix if present, otherwise return as-is
  final cleaned = error.toString().replaceFirst(RegExp(r'^Exception:\s*'), '');
  return cleaned;
}
