import 'package:flutter/material.dart';
import 'package:gym_fitness_app/utils/appui_helper.dart';
import '../services/api_service.dart';
import '../models/models.dart';
import '../utils/app_utils.dart';

class AddMemberScreen extends StatefulWidget {
  const AddMemberScreen({super.key});

  @override
  State<AddMemberScreen> createState() => _AddMemberScreenState();
}

class _AddMemberScreenState extends State<AddMemberScreen> {
  final formKey = GlobalKey<FormState>();
  final nameController = TextEditingController();
  final phoneController = TextEditingController();
  final emailController = TextEditingController();
  final feeController = TextEditingController();

  DateTime expiryDate = DateTime.now().add(const Duration(days: 30));
  DateTime? lastVisitDate;
  String? selectedTrainerId;
  String? phoneError;
  String? nameError;
  String? emailError;
  String? feeError;

  late Future<StaffResponse> staffFuture;
  bool _isSubmitting = false;

  @override
  void initState() {
    super.initState();
    staffFuture = ApiService().getStaff();
  }

  @override
  void dispose() {
    nameController.dispose();
    phoneController.dispose();
    emailController.dispose();
    feeController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!formKey.currentState!.validate()) return;

    setState(() => _isSubmitting = true);

    try {
      await ApiService().createCustomer(
        name: nameController.text.trim(),
        phone: phoneController.text.trim(),
        email: emailController.text.trim(),
        lastVisitDate: lastVisitDate?.toString().split(' ')[0],
        subscriptionEndDate: expiryDate.toUtc().toIso8601String(),
        planFee: double.parse(feeController.text),
        assignedStaffId: selectedTrainerId,
      );
      if (mounted) {
        AppUiHelper().showModernSnackBar(context, message: "Customer added successfully");
        Navigator.pop(context, true); // return true = refresh list
      }
    } catch (e) {
      if (mounted) {
        AppUiHelper().showModernSnackBar(context, message: e.toString(), isError: true);
      }
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Add Customer'),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Form(
          key: formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextFormField(
                autovalidateMode: AutovalidateMode.onUserInteraction,
                controller: nameController,
                decoration: InputDecoration(
                  labelText: 'Full Name *',
                  prefixIcon: const Icon(Icons.person),
                  errorText: nameError,
                ),
                validator: (v) {
                  if (v == null || v.trim().isEmpty) return 'Name is required';
                  if (v.trim().length < 3) return 'Name must be at least 3 characters';
                  return null;
                },
                onChanged: (v) {
                  setState(() => nameError = AppUtils.validateName(v));
                },
              ),
              const SizedBox(height: 12),
              TextFormField(
                autovalidateMode: AutovalidateMode.onUserInteraction,
                controller: phoneController,
                keyboardType: TextInputType.phone,
                decoration: InputDecoration(
                  labelText: 'Phone Number *',
                  prefixIcon: const Icon(Icons.phone),
                  errorText: phoneError,
                ),
                validator: (v) => AppUtils.validatePhoneNumber(v),
                onChanged: (v) {
                  setState(() => phoneError = AppUtils.validatePhoneNumber(v));
                },
              ),
              const SizedBox(height: 12),
              TextFormField(
                autovalidateMode: AutovalidateMode.onUserInteraction,
                controller: emailController,
                keyboardType: TextInputType.emailAddress,
                decoration: InputDecoration(
                  labelText: 'Email Address *',
                  prefixIcon: const Icon(Icons.email),
                  errorText: emailError,
                ),
                validator: (v) => AppUtils.validateEmail(v),
                onChanged: (v) {
                  setState(() => emailError = AppUtils.validateEmail(v));
                },
              ),
              const SizedBox(height: 12),
              TextFormField(
                autovalidateMode: AutovalidateMode.onUserInteraction,
                controller: feeController,
                keyboardType: TextInputType.number,
                decoration: InputDecoration(
                  labelText: 'Plan Fee (₹) *',
                  prefixIcon: const Icon(Icons.currency_rupee),
                  errorText: feeError,
                ),
                validator: (v) => AppUtils.validatePlanFee(v),
                onChanged: (v) {
                  setState(() => feeError = AppUtils.validatePlanFee(v));
                },
              ),
              const SizedBox(height: 12),
              FutureBuilder<StaffResponse>(
                future: staffFuture,
                builder: (context, snapshot) {
                  final trainers = snapshot.data?.staff ?? [];
                  return DropdownButtonFormField<String>(
                    decoration: const InputDecoration(
                      labelText: 'Assign Staff (Optional)',
                      prefixIcon: Icon(Icons.person_pin),
                    ),
                    initialValue: selectedTrainerId,
                    items: [
                      const DropdownMenuItem<String>(
                        value: null,
                        child: Text('No Staff (Admin manages)'),
                      ),
                      ...trainers.map((t) => DropdownMenuItem<String>(
                        value: t.id,
                        child: Text(t.name),
                      )),
                    ],
                    onChanged: (v) => setState(() => selectedTrainerId = v),
                  );
                },
              ),
              const SizedBox(height: 12),
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.fitness_center, color: Colors.grey),
                title: const Text('Last Visit Date'),
                subtitle: Text(
                  lastVisitDate != null
                      ? lastVisitDate!.toString().split(' ')[0]
                      : 'Tap to set (optional)',
                  style: TextStyle(
                    color: lastVisitDate != null ? Colors.black87 : Colors.grey,
                  ),
                ),
                onTap: () async {
                  final d = await showDatePicker(
                    context: context,
                    initialDate: DateTime.now(),
                    firstDate: DateTime.now().subtract(const Duration(days: 365)),
                    lastDate: DateTime.now(),
                  );
                  if (d != null) setState(() => lastVisitDate = d);
                },
              ),
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.calendar_today, color: Colors.blue),
                title: const Text('Subscription End *'),
                subtitle: Text(expiryDate.toString().split(' ')[0]),
                onTap: () async {
                  final d = await showDatePicker(
                    context: context,
                    initialDate: expiryDate,
                    firstDate: DateTime.now(),
                    lastDate: DateTime.now().add(const Duration(days: 3650)),
                  );
                  if (d != null) setState(() => expiryDate = d);
                },
              ),
              const SizedBox(height: 24),
              SizedBox(
                height: 50,
                child: ElevatedButton(
                  onPressed: _isSubmitting ? null : _submit,
                  child: _isSubmitting
                      ? const SizedBox(
                    width: 22,
                    height: 22,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
                    ),
                  )
                      : const Text('Add Customer'),
                ),
              ),
              const SizedBox(height: 16),
            ],
          ),
        ),
      ),
    );
  }
}