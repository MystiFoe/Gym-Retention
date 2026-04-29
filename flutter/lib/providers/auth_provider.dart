import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../services/api_service.dart';
import '../models/models.dart';

final authProvider = StateNotifierProvider<AuthNotifier, AuthState>((ref) {
  return AuthNotifier();
});

class AuthNotifier extends StateNotifier<AuthState> {
  AuthNotifier() : super(const AuthState.initial());
  void setAuthenticated(LoginResponse data) {
    state = AuthState.authenticated(data);
  }

  Future<void> login(String email, String password, String role) async {
    state = const AuthState.loading();
    try {
      final response = await ApiService().login(
        email: email,
        password: password,
        role: role,
      );
      state = AuthState.authenticated(response);
    } catch (e) {
      state = AuthState.error(e.toString());
    }
  }

  void logout() {
    state = const AuthState.initial();
  }

  Future<void> setLoggedOut() async {
    await ApiService().logout();
    state = const AuthState.initial();
  }
}

class AuthState {
  final LoginResponse? data;
  final bool isLoading;
  final String? error;

  const AuthState({
    this.data,
    this.isLoading = false,
    this.error,
  });

  const AuthState.initial() : this(data: null, isLoading: false, error: null);
  const AuthState.loading() : this(isLoading: true);
  AuthState.authenticated(this.data) : isLoading = false, error = null;
  AuthState.error(this.error) : isLoading = false, data = null;

  bool get isAuthenticated => data != null;
}
