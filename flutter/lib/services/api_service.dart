import 'package:http/http.dart' as http;
import 'dart:convert';
import 'package:flutter/foundation.dart' show kIsWeb, kReleaseMode;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../models/models.dart';

// ── API base URL ─────────────────────────────────────────────────────────────
// Web     : relative '/api' — works on ANY domain (recurva.in, recurva-app.web.app)
//           Avoids cross-origin issues entirely; the browser resolves it to the
//           current domain automatically.
// Mobile  : absolute prod URL (recurva.in is the canonical custom domain)
// Dev     : localhost
const String _devUrl  = 'http://localhost:3000/api';
const String _prodUrl = 'https://recurva.in/api';
// ignore: do_not_use_environment
const String baseUrl  = kIsWeb ? '/api' : (kReleaseMode ? _prodUrl : _devUrl);
class ApiService {
  static final ApiService _instance = ApiService._internal();
  
  factory ApiService() {
    return _instance;
  }
  
  ApiService._internal();

  // Called with true on login/token-save, false on logout
  static void Function(bool)? onAuthChanged;

  // Tokens stored securely (Keychain on iOS, Keystore on Android, encrypted IndexedDB on web)
  final _secureStorage = const FlutterSecureStorage(
    webOptions: WebOptions(dbName: 'recurvaSecure', publicKey: 'recurvaKey'),
  );

  String? _accessToken;
  String? _refreshToken;

  bool get isLoggedIn => _accessToken != null && _accessToken!.isNotEmpty;

  Future<void> loadTokens() async {
    _accessToken = await _secureStorage.read(key: 'access_token');
    _refreshToken = await _secureStorage.read(key: 'refresh_token');
  }

  Future<void> _saveTokens(String accessToken, String refreshToken) async {
    await Future.wait([
      _secureStorage.write(key: 'access_token', value: accessToken),
      _secureStorage.write(key: 'refresh_token', value: refreshToken),
    ]);
    _accessToken = accessToken;
    _refreshToken = refreshToken;
    onAuthChanged?.call(true);
  }

  Map<String, String> _getHeaders() {
    return {
      'Content-Type': 'application/json',
      if (_accessToken != null) 'Authorization': 'Bearer $_accessToken',
    };
  }
  // Future<T> _handleResponse<T>(http.Response response, T Function(dynamic) fromJson) async {
  //   // ❌ This runs BEFORE checking status — wrong!
  //   // if (response.statusCode == 401) { ... }
  //
  //   print("🌐 API RESPONSE [${response.request?.url}]");
  //   print("STATUS: ${response.statusCode}");
  //   print("BODY: ${response.body}");
  //
  //   if (response.statusCode >= 400) {
  //     final body = jsonDecode(response.body);
  //     String message = body['error'] ?? '';
  //     if (message.isEmpty && body['errors'] is List) {
  //       message = (body['errors'] as List)
  //           .map((e) => '${e['field']}: ${e['message']}')
  //           .join(', ');
  //     }
  //
  //     // ✅ Handle 401 here properly
  //     if (response.statusCode == 401) {
  //       if (_refreshToken != null) {
  //         final refreshed = await _refreshAccessToken();
  //         if (!refreshed) {
  //           throw UnauthorizedException('Session expired');
  //         }
  //       } else {
  //         throw UnauthorizedException('Session expired');
  //       }
  //     }
  //
  //     throw ApiException(
  //       message.isEmpty ? 'Request failed (${response.statusCode})' : message,
  //       response.statusCode,
  //     );
  //   }
  //
  //   final body = jsonDecode(response.body);
  //   if (body['success'] == false) {
  //     String message = body['error'] ?? '';
  //     if (message.isEmpty && body['errors'] is List) {
  //       message = (body['errors'] as List)
  //           .map((e) => '${e['field']}: ${e['message']}')
  //           .join(', ');
  //     }
  //     throw ApiException(message.isEmpty ? 'Unknown error' : message, response.statusCode);
  //   }
  //
  //   return fromJson(body['data']);
  // }

  Future<T> _handleResponse<T>(
      http.Response response,
      T Function(dynamic) fromJson,
      ) async {

    dynamic body;
    try {
      body = jsonDecode(response.body);
    } catch (_) {
      body = {};
    }

    // 🔴 HANDLE ERRORS
    if (response.statusCode >= 400) {
      String message = body['error'] ?? '';

      if (message.isEmpty && body['errors'] is List) {
        message = (body['errors'] as List)
            .map((e) => '${e['field']}: ${e['message']}')
            .join(', ');
      }

      // =========================
      // 🔥 HANDLE 401 PROPERLY
      // =========================
      if (response.statusCode == 401) {
        // ✅ CASE 1: LOGIN / NO TOKEN → INVALID CREDENTIALS
        if (_accessToken == null || _accessToken!.isEmpty) {
          throw ApiException(
            message.isNotEmpty ? message : 'Invalid credentials',
            401,
          );
        }

        // ✅ CASE 2: TOKEN EXPIRED → TRY REFRESH
        if (_refreshToken != null) {
          final refreshed = await _refreshAccessToken();

          if (refreshed) {
            // Retry original request with new token.
            // Read bodyBytes BEFORE finalize() — after send() the request is
            // already finalized so calling finalize() again would throw
            // "Bad state: Can't finalize a finalized Request".
            final orig = response.request;
            final bodyBytes = (orig is http.Request) ? orig.bodyBytes : <int>[];

            final retryResponse = http.Request(orig!.method, orig.url)
              ..headers.addAll(_getHeaders())
              ..bodyBytes = bodyBytes;

            final streamed = await retryResponse.send();
            final newResponse = await http.Response.fromStream(streamed);

            return _handleResponse(newResponse, fromJson);
          }
        }

        // ❌ Refresh failed → logout
        await logout();
        throw UnauthorizedException(
          message.isNotEmpty ? message : 'Session expired',
        );
      }

      // 🔴 OTHER ERRORS
      throw ApiException(
        message.isNotEmpty
            ? message
            : 'Request failed (${response.statusCode})',
        response.statusCode,
      );
    }

    // =========================
    // ✅ SUCCESS RESPONSE
    // =========================
    if (body['success'] == false) {
      String message = body['error'] ?? '';

      if (message.isEmpty && body['errors'] is List) {
        message = (body['errors'] as List)
            .map((e) => '${e['field']}: ${e['message']}')
            .join(', ');
      }

      throw ApiException(
        message.isNotEmpty ? message : 'Unknown error',
        response.statusCode,
      );
    }

    return fromJson(body['data']);
  }

  // Future<T> _handleResponse<T>(http.Response response, T Function(dynamic) fromJson) async {
  //   // if (response.statusCode == 401) {
  //   //   // Token expired, try refresh
  //   //   if (_refreshToken != null) {
  //   //     final refreshed = await _refreshAccessToken();
  //   //     if (!refreshed) {
  //   //       throw UnauthorizedException('Session expired');
  //   //     }
  //   //   }
  //   // }
  //   print("🌐 API RESPONSE [${response.request?.url}]");
  //   print("STATUS: ${response.statusCode}");
  //   print("BODY: ${response.body}");
  //   if (response.statusCode >= 400) {
  //     final body = jsonDecode(response.body);
  //     // Zod returns 'errors' (array), other errors return 'error' (string)
  //     String message = body['error'] ?? '';
  //     if (message.isEmpty && body['errors'] is List) {
  //       message = (body['errors'] as List)
  //           .map((e) => '${e['field']}: ${e['message']}')
  //           .join(', ');
  //     }
  //     throw ApiException(message.isEmpty ? 'Request failed (${response.statusCode})' : message, response.statusCode);
  //   }
  //
  //   final body = jsonDecode(response.body);
  //   if (body['success'] == false) {
  //     String message = body['error'] ?? '';
  //     if (message.isEmpty && body['errors'] is List) {
  //       message = (body['errors'] as List)
  //           .map((e) => '${e['field']}: ${e['message']}')
  //           .join(', ');
  //     }
  //     throw ApiException(message.isEmpty ? 'Unknown error' : message, response.statusCode);
  //   }
  //
  //   return fromJson(body['data']);
  // }

  Future<bool> _refreshAccessToken() async {
    try {
      final response = await http.post(
        Uri.parse('$baseUrl/auth/refresh'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'refresh_token': _refreshToken}),
      );

      if (response.statusCode == 200) {
        final body = jsonDecode(response.body);
        await _saveTokens(body['data']['access_token'], body['data']['refresh_token']);
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  // ============================================================================
  // AUTHENTICATION ENDPOINTS
  // ============================================================================

  Future<LoginResponse> login({
    required String email,
    required String password,
    required String role,
    String? gymId,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/auth/login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'phone_or_email': email,
        'password': password,
        'role': role,
        'gym_id': ?gymId,
      }),
    );

    final result = await _handleResponse(response, (data) => LoginResponse.fromJson(data));
    await _saveTokens(result.accessToken, result.refreshToken);
    // Save user info for screens to use
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('user_id', result.user.id);
    await prefs.setString('gym_id', result.user.businessId);
    await prefs.setString('user_role', result.user.role);
    return result;
  }

  Future<void> logout() async {
    await Future.wait([
      _secureStorage.delete(key: 'access_token'),
      _secureStorage.delete(key: 'refresh_token'),
    ]);
    _accessToken = null;
    _refreshToken = null;
    onAuthChanged?.call(false);
  }

  // ============================================================================
  // PROFILE ENDPOINTS
  // ============================================================================

  Future<UserProfile> getProfile() async {
    final response = await http.get(
      Uri.parse('$baseUrl/profile'),
      headers: _getHeaders(),
    );
    return _handleResponse(response, (data) => UserProfile.fromJson(data));
  }

  Future<void> updateProfile({
    required String name,
    String? phone,
    String? email,
    String? currentPassword,
    String? newPassword,
  }) async {
    final response = await http.put(
      Uri.parse('$baseUrl/profile'),
      headers: _getHeaders(),
      body: jsonEncode({
        'name': name,
        if (phone != null && phone.isNotEmpty) 'phone': phone,
        if (email != null && email.isNotEmpty) 'email': email,
        if (currentPassword != null && currentPassword.isNotEmpty) 'currentPassword': currentPassword,
        if (newPassword != null && newPassword.isNotEmpty) 'newPassword': newPassword,
      }),
    );
    _handleResponse(response, (data) => data);
  }

  Future<void> verifyProfilePhone(String firebaseIdToken) async {
    final response = await http.post(
      Uri.parse('$baseUrl/profile/verify-phone'),
      headers: _getHeaders(),
      body: jsonEncode({'firebase_id_token': firebaseIdToken}),
    );
    await _handleResponse(response, (data) => data);
  }

  Future<void> updateGym({
    required String gymName,
    String? address,
    String? phone,
  }) async {
    final response = await http.put(
      Uri.parse('$baseUrl/gyms/me'),
      headers: _getHeaders(),
      body: jsonEncode({
        'gymName': gymName,
        'address': ?address,
        if (phone != null && phone.isNotEmpty) 'phone': phone,
      }),
    );
    _handleResponse(response, (data) => data);
  }

  Future<void> forgotPassword({required String email}) async {
    final response = await http.post(
      Uri.parse('$baseUrl/auth/forgot-password'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'email': email}),
    );
    if (response.statusCode >= 400) {
      final body = jsonDecode(response.body);
      throw Exception(body['error'] ?? 'Request failed');
    }
  }

  Future<void> resetPassword({required String token, required String newPassword}) async {
    final response = await http.post(
      Uri.parse('$baseUrl/auth/reset-password'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'token': token, 'new_password': newPassword}),
    );
    if (response.statusCode >= 400) {
      final body = jsonDecode(response.body);
      throw Exception(body['error'] ?? 'Request failed');
    }
  }

  /// Verify the 6-digit OTP from forgot-password email.
  /// Returns a reset token to pass to [resetPassword].
  Future<String> verifyResetOtp({required String email, required String otpCode}) async {
    final response = await http.post(
      Uri.parse('$baseUrl/auth/verify-reset-otp'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'email': email, 'otp_code': otpCode}),
    );
    final body = jsonDecode(response.body);
    if (response.statusCode >= 400) {
      throw Exception(body['error'] ?? 'Verification failed');
    }
    return body['data']['reset_token'] as String;
  }

  /// Exchange a Firebase Phone ID token for the app's own JWT.
  /// Used by [PhoneOtpScreen] after Firebase verifies the SMS code.
  Future<void> verifyFirebaseToken({
    required String firebaseIdToken,
    required String role,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/auth/verify-firebase-token'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'firebase_id_token': firebaseIdToken, 'role': role}),
    );
    final body = jsonDecode(response.body);
    if (response.statusCode >= 400) {
      throw Exception(body['error'] ?? 'Firebase login failed');
    }
    final data = body['data'] as Map<String, dynamic>;
    await _saveTokens(data['access_token'] as String, data['refresh_token'] as String);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('user_id',   data['user']['id']     as String);
    await prefs.setString('gym_id',    data['user']['gym_id'] as String);
    await prefs.setString('user_role', data['user']['role']   as String);
  }

  /// Used by the forgot-password OTP flow: verifies Firebase phone token and
  /// returns a short-lived password-reset token for [ResetPasswordScreen].
  Future<String> phoneResetToken({required String firebaseIdToken}) async {
    final response = await http.post(
      Uri.parse('$baseUrl/auth/phone-reset-token'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'firebase_id_token': firebaseIdToken}),
    );
    final body = jsonDecode(response.body);
    if (response.statusCode >= 400) {
      throw Exception(body['error'] ?? 'Phone verification failed');
    }
    return body['data']['reset_token'] as String;
  }

  // ============================================================================
  // BUSINESS ENDPOINTS
  // ============================================================================

  /// STEP 1: Initiate business registration.
  /// Sends email OTP; no business record is created until both verifications pass.
  Future<BusinessRegistrationResponse> registerBusiness({
    required String businessName,
    required String ownerName,
    required String phone,
    required String email,
    required String address,
    required String ownerPassword,
    required String ownerEmail,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/gyms/register'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'gym_name': businessName,
        'owner_name': ownerName,
        'phone': phone,
        'email': email,
        'address': address,
        'owner_password': ownerPassword,
        'owner_email': ownerEmail,
      }),
    );
    return _handleResponse(response, (data) => BusinessRegistrationResponse.fromJson(data));
  }

  /// STEP 2: Verify the 6-digit email OTP sent during registration.
  Future<RegistrationEmailVerifyResponse> verifyRegistrationEmail({
    required String pendingId,
    required String otpCode,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/gyms/register/verify-email'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'pending_id': pendingId, 'otp_code': otpCode}),
    );
    return _handleResponse(
      response,
      (data) => RegistrationEmailVerifyResponse.fromJson(data),
    );
  }

  /// Save the device FCM push token for the logged-in user.
  Future<void> updateFcmToken(String fcmToken) async {
    try {
      await http.put(
        Uri.parse('$baseUrl/auth/fcm-token'),
        headers: _getHeaders(),
        body: jsonEncode({'fcm_token': fcmToken}),
      );
    } catch (_) {
      // Non-critical — silently ignore
    }
  }

  /// STEP 2b: Request a new email OTP (if the first one expired or wasn't received).
  Future<void> resendRegistrationEmailOtp({required String pendingId}) async {
    final response = await http.post(
      Uri.parse('$baseUrl/gyms/register/resend-email-otp'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'pending_id': pendingId}),
    );
    if (response.statusCode >= 400) {
      final body = jsonDecode(response.body);
      throw ApiException(
        body['error'] ?? 'Failed to resend code',
        response.statusCode,
      );
    }
  }

  /// STEP 3: Complete registration after Firebase phone OTP is verified.
  /// Creates the business + user records and issues JWTs (auto-login).
  Future<void> completeRegistration({
    required String pendingId,
    required String firebaseIdToken,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/gyms/register/verify-phone'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'pending_id': pendingId,
        'firebase_id_token': firebaseIdToken,
      }),
    );
    final body = jsonDecode(response.body);
    if (response.statusCode >= 400) {
      throw ApiException(
        body['error'] ?? 'Phone verification failed',
        response.statusCode,
      );
    }
    final data = body['data'] as Map<String, dynamic>;
    await _saveTokens(
      data['access_token'] as String,
      data['refresh_token'] as String,
    );
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('user_id',   data['user']['id']     as String);
    await prefs.setString('gym_id',    data['user']['gym_id'] as String);
    await prefs.setString('user_role', data['user']['role']   as String);
  }

  Future<BusinessSubscriptionResponse> getBusinessSubscription(String businessId) async {
    final response = await http.get(
      Uri.parse('$baseUrl/gyms/$businessId/subscription'),
      headers: _getHeaders(),
    );
    return _handleResponse(response, (data) => BusinessSubscriptionResponse.fromJson(data));
  }

  Future<RazorpayOrderResponse> createBillingOrder({
    required String businessId,
    required String plan,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/gyms/$businessId/billing/create-order'),
      headers: _getHeaders(),
      body: jsonEncode({'plan': plan}),
    );
    return _handleResponse(response, (data) => RazorpayOrderResponse.fromJson(data));
  }

  Future<Map<String, dynamic>> verifyPayment({
    required String businessId,
    required String razorpayOrderId,
    required String razorpayPaymentId,
    required String razorpaySignature,
    required String plan,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/gyms/$businessId/billing/verify-payment'),
      headers: _getHeaders(),
      body: jsonEncode({
        'razorpay_order_id': razorpayOrderId,
        'razorpay_payment_id': razorpayPaymentId,
        'razorpay_signature': razorpaySignature,
        'plan': plan,
      }),
    );
    return _handleResponse(response, (data) => data as Map<String, dynamic>);
  }

  // ============================================================================
  // CUSTOMERS ENDPOINTS
  // ============================================================================

  Future<CustomersResponse> getCustomers({
    int page = 1,
    int limit = 10,
    String? status,
    String? staffId,
  }) async {
    final params = <String, String>{
      'page': page.toString(),
      'limit': limit.toString(),
      'status': ?status,
      'trainer_id': ?staffId,
    };
    final uri = Uri.parse('$baseUrl/members').replace(queryParameters: params);
    final response = await http.get(uri, headers: _getHeaders());
    return _handleResponse(response, (data) => CustomersResponse.fromJson(data));
  }

  Future<Customer> createCustomer({
    required String name,
    required String phone,
    String? email,
    String? lastVisitDate,
    required String subscriptionEndDate,
    required double planFee,
    String? assignedStaffId,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/members'),
      headers: _getHeaders(),
      body: jsonEncode({
        'name': name,
        'phone': phone,
        if (email != null && email.isNotEmpty) 'email': email,
        'last_visit_date': ?lastVisitDate,
        'membership_expiry_date': subscriptionEndDate,
        'plan_fee': planFee,
        'assigned_trainer_id': ?assignedStaffId,
      }),
    );
    return _handleResponse(response, (data) => Customer.fromJson(data));
  }

  Future<Customer> updateCustomer({
    required String customerId,
    required String name,
    required String phone,
    required String email,
    required String subscriptionEndDate,
    required double planFee,
    required String staffId,
  }) async {
    final response = await http.put(
      Uri.parse('$baseUrl/members/$customerId'),
      headers: _getHeaders(),
      body: jsonEncode({
        'name': name,
        'phone': phone,
        'email': email,
        'membership_expiry_date': subscriptionEndDate,
        'plan_fee': planFee,
        'assigned_trainer_id': staffId,
      }),
    );
    return _handleResponse(response, (data) => Customer.fromJson(data));
  }

  Future<void> deleteCustomer(String customerId) async {
    final response = await http.delete(
      Uri.parse('$baseUrl/members/$customerId'),
      headers: _getHeaders(),
    );
    await _handleResponse(response, (_) => null);
  }

  /// Bulk import customers. Sends up to [chunkSize] rows per request.
  /// Returns a map with keys: imported, skipped, failed, errors.
  Future<Map<String, dynamic>> bulkImportCustomers(
    List<Map<String, dynamic>> rows, {
    String? staffId,
    int chunkSize = 2000,
    void Function(int sent, int total)? onProgress,
  }) async {
    int totalImported = 0;
    int totalSkipped = 0;
    int totalFailed = 0;
    final List<String> allErrors = [];

    final total = rows.length;
    int sent = 0;

    for (int i = 0; i < rows.length; i += chunkSize) {
      final chunk = rows.sublist(i, i + chunkSize > rows.length ? rows.length : i + chunkSize);
      final body = <String, dynamic>{'members': chunk};
      if (staffId != null && staffId.isNotEmpty) {
        body['trainer_id'] = staffId;
      }

      final response = await http.post(
        Uri.parse('$baseUrl/members/bulk-import'),
        headers: _getHeaders(),
        body: jsonEncode(body),
      );

      final result = await _handleResponse(response, (data) => data as Map<String, dynamic>);
      totalImported += (result['imported'] as int? ?? 0);
      totalSkipped  += (result['skipped']  as int? ?? 0);
      totalFailed   += (result['failed']   as int? ?? 0);
      if (result['errors'] is List) {
        allErrors.addAll((result['errors'] as List).map((e) => e.toString()));
      }

      sent += chunk.length;
      onProgress?.call(sent, total);
    }

    return {
      'imported': totalImported,
      'skipped':  totalSkipped,
      'failed':   totalFailed,
      'errors':   allErrors,
    };
  }

  // ============================================================================
  // STAFF ENDPOINTS
  // ============================================================================

  Future<StaffResponse> getStaff({int page = 1, int limit = 20}) async {
    final uri = Uri.parse('$baseUrl/trainers').replace(queryParameters: {
      'page': page.toString(),
      'limit': limit.toString(),
    });
    final response = await http.get(uri, headers: _getHeaders());
    return _handleResponse(response, (data) => StaffResponse.fromJson(data));
  }

  Future<Staff> createStaff({
    required String name,
    required String phone,
    required String email,
    required String password,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/trainers'),
      headers: _getHeaders(),
      body: jsonEncode({
        'name': name,
        'phone': phone,
        'email': email,
        'password': password,
      }),
    );
    return _handleResponse(response, (data) => Staff.fromJson(data));
  }

  Future<Staff> getMyStaffProfile() async {
    await loadTokens();
    final response = await http.get(
      Uri.parse('$baseUrl/trainers/me'),
      headers: _getHeaders(),
    );
    return _handleResponse(response, (data) => Staff.fromJson(data));
  }

  Future<Staff> updateStaff({
    required String staffId,
    required String name,
    required String phone,
    String? email,
  }) async {
    final response = await http.patch(
      Uri.parse('$baseUrl/trainers/$staffId'),
      headers: _getHeaders(),
      body: jsonEncode({
        'name': name,
        'phone': phone,
        if (email != null && email.isNotEmpty) 'email': email,
      }),
    );
    return _handleResponse(response, (data) => Staff.fromJson(data));
  }

  Future<void> assignCustomersToStaff({
    required String staffId,
    required List<String> customerIds,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/trainers/$staffId/assign-members'),
      headers: _getHeaders(),
      body: jsonEncode({'member_ids': customerIds}),
    );
    await _handleResponse(response, (_) => null);
  }

  Future<void> deleteStaff(String staffId) async {
    final response = await http.delete(
      Uri.parse('$baseUrl/trainers/$staffId'),
      headers: _getHeaders(),
    );
    await _handleResponse(response, (_) => null);
  }

  // ============================================================================
  // TASKS ENDPOINTS
  // ============================================================================

  Future<Task> createTask({
    required String customerId,
    required String taskType,
    String? assignedStaffId,
    String? notes,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/tasks'),
      headers: _getHeaders(),
      body: jsonEncode({
        'member_id': customerId,
        'task_type': taskType,
        'assigned_trainer_id': ?assignedStaffId,
        if (notes != null && notes.isNotEmpty) 'notes': notes,
      }),
    );
    return _handleResponse(response, (data) => Task.fromJson(data));
  }

  Future<TasksResponse> getTasks({
    String? status,
    String? staffId,
    String? customerId,
    int page = 1,
    int limit = 20,
  }) async {
    final params = <String, String>{
      'page': page.toString(),
      'limit': limit.toString(),
    };
    if (status != null)   params['status']     = status;
    if (staffId != null)  params['trainer_id'] = staffId;
    if (customerId != null) params['member_id'] = customerId;
    final uri = Uri.parse('$baseUrl/tasks').replace(queryParameters: params);
    final response = await http.get(uri, headers: _getHeaders());
    return _handleResponse(response, (data) => TasksResponse.fromJson(data));
  }

  Future<Task> completeTask({
    required String taskId,
    required String outcome,
    String? notes,
  }) async {
    final response = await http.patch(
      Uri.parse('$baseUrl/tasks/$taskId'),
      headers: _getHeaders(),
      body: jsonEncode({
        'outcome': outcome,
        'notes': notes,
      }),
    );

    return _handleResponse(response, (data) => Task.fromJson(data));
  }

  // ============================================================================
  // ATTENDANCE ENDPOINTS
  // ============================================================================

  Future<void> markAttendance({
    required String customerId,
    required String visitDate,
    String? checkInTime,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/attendance'),
      headers: _getHeaders(),
      body: jsonEncode({
        'member_id': customerId,
        'visit_date': visitDate,
        'check_in_time': ?checkInTime,
      }),
    );

    await _handleResponse(response, (_) => null);
  }

  Future<AttendanceResponse> getAttendance({String? date}) async {
    final uri = Uri.parse('$baseUrl/attendance').replace(
      queryParameters: date != null ? {'date': date} : null,
    );
    final response = await http.get(uri, headers: _getHeaders());
    return _handleResponse(response, (data) => AttendanceResponse.fromJson(data));
  }

  /// Fetch a customer's attendance calendar for a given month.
  /// [customerId] – UUID of the customer.
  /// [month]      – Month in YYYY-MM format (defaults to current month if omitted).
  Future<CustomerAttendanceResponse> getCustomerAttendance({
    required String customerId,
    String? month,
  }) async {
    final params = <String, String>{};
    if (month != null) params['month'] = month;
    final uri = Uri.parse('$baseUrl/members/$customerId/attendance')
        .replace(queryParameters: params.isNotEmpty ? params : null);
    final response = await http.get(uri, headers: _getHeaders());
    return _handleResponse(
      response,
      (data) => CustomerAttendanceResponse.fromJson(data),
    );
  }

  // ============================================================================
  // DASHBOARD ENDPOINTS
  // ============================================================================

  Future<DashboardKPIs> getDashboardKPIs() async {
    final response = await http.get(
      Uri.parse('$baseUrl/dashboard/kpis'),
      headers: _getHeaders(),
    );

    return _handleResponse(response, (data) => DashboardKPIs.fromJson(data));
  }

  Future<RevenueResponse> getRevenue() async {
    final response = await http.get(
      Uri.parse('$baseUrl/revenue'),
      headers: _getHeaders(),
    );

    return _handleResponse(response, (data) => RevenueResponse.fromJson(data));
  }

  // ============================================================================
  // DATA EXPORT & GDPR ENDPOINTS
  // ============================================================================

  /// Returns CSV bytes for all customers. Caller should trigger a browser download.
  Future<List<int>> exportCustomersCsv() async {
    final response = await http.get(
      Uri.parse('$baseUrl/members/export'),
      headers: _getHeaders(),
    );
    if (response.statusCode == 401) throw UnauthorizedException('Session expired');
    if (response.statusCode >= 400) {
      final body = jsonDecode(response.body);
      throw ApiException(body['error'] ?? 'Export failed', response.statusCode);
    }
    return response.bodyBytes.toList();
  }

  Future<void> deleteCustomerData(String customerId) async {
    final response = await http.delete(
      Uri.parse('$baseUrl/members/$customerId/data'),
      headers: _getHeaders(),
    );
    if (response.statusCode == 401) throw UnauthorizedException('Session expired');
    if (response.statusCode >= 400) {
      final body = jsonDecode(response.body);
      throw ApiException(body['error'] ?? 'Delete failed', response.statusCode);
    }
  }

  // ============================================================================
  // ADMIN ENDPOINTS
  // ============================================================================

  Map<String, String> _adminHeaders(String secret) => {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer $secret',
  };

  Future<List<AdminBusiness>> adminGetBusinesses(String secret) async {
    final response = await http.get(
      Uri.parse('$baseUrl/admin/gyms'),
      headers: _adminHeaders(secret),
    );
    if (response.statusCode == 401) throw Exception('Invalid admin secret');
    if (response.statusCode >= 400) {
      final body = jsonDecode(response.body);
      throw Exception(body['error'] ?? 'Request failed');
    }
    final body = jsonDecode(response.body);
    return (body['data']['gyms'] as List).map((g) => AdminBusiness.fromJson(g)).toList();
  }

  Future<void> adminSuspendBusiness(String secret, String businessId) async {
    final response = await http.post(
      Uri.parse('$baseUrl/admin/gyms/$businessId/suspend'),
      headers: _adminHeaders(secret),
    );
    if (response.statusCode == 401) throw Exception('Invalid admin secret');
    if (response.statusCode >= 400) {
      final body = jsonDecode(response.body);
      throw Exception(body['error'] ?? 'Request failed');
    }
  }

  Future<void> adminReactivateBusiness(String secret, String businessId) async {
    final response = await http.post(
      Uri.parse('$baseUrl/admin/gyms/$businessId/reactivate'),
      headers: _adminHeaders(secret),
    );
    if (response.statusCode == 401) throw Exception('Invalid admin secret');
    if (response.statusCode >= 400) {
      final body = jsonDecode(response.body);
      throw Exception(body['error'] ?? 'Request failed');
    }
  }

  Future<void> adminDeleteBusiness(String secret, String businessId) async {
    final response = await http.delete(
      Uri.parse('$baseUrl/admin/gyms/$businessId'),
      headers: _adminHeaders(secret),
    );
    if (response.statusCode == 401) throw Exception('Invalid admin secret');
    if (response.statusCode >= 400) {
      final body = jsonDecode(response.body);
      throw Exception(body['error'] ?? 'Request failed');
    }
  }

  Future<void> adminConvertBusiness(String secret, String businessId, int months) async {
    final response = await http.post(
      Uri.parse('$baseUrl/admin/gyms/$businessId/convert'),
      headers: _adminHeaders(secret),
      body: jsonEncode({'months': months}),
    );
    if (response.statusCode == 401) throw Exception('Invalid admin secret');
    if (response.statusCode >= 400) {
      final body = jsonDecode(response.body);
      throw Exception(body['error'] ?? 'Request failed');
    }
  }
}

// ============================================================================
// CUSTOM EXCEPTIONS
// ============================================================================

class ApiException implements Exception {
  final String message;
  final int statusCode;

  ApiException(this.message, this.statusCode);

  @override
  String toString() => message;
}

class UnauthorizedException extends ApiException {
  UnauthorizedException(String message) : super(message, 401);
}

// ============================================================================
// API SERVICE PROVIDER
// ============================================================================

final apiServiceProvider = Provider((ref) {
  return ApiService();
});
