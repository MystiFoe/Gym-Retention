import 'package:flutter/material.dart';
import 'package:gym_fitness_app/utils/appui_helper.dart';
import '../services/api_service.dart';
import '../models/models.dart';
import '../utils/app_utils.dart';

class EditMemberScreen extends StatefulWidget {
  final Customer member;
  const EditMemberScreen({super.key, required this.member});

  @override
  State<EditMemberScreen> createState() => _EditMemberScreenState();
}

class _EditMemberScreenState extends State<EditMemberScreen> {
  final formKey = GlobalKey<FormState>();
  late TextEditingController nameController;
  late TextEditingController phoneController;
  late TextEditingController emailController;
  late TextEditingController feeController;

  late DateTime expiryDate;
  String? phoneError;
  String? nameError;
  String? emailError;
  String? feeError;
  bool _isSubmitting = false;

  List<Staff> _staffList = [];
  String? _selectedStaffId; // null = unassigned

  @override
  void initState() {
    super.initState();
    nameController = TextEditingController(text: widget.member.name);
    phoneController = TextEditingController(text: widget.member.phone);
    emailController = TextEditingController(text: widget.member.email);
    feeController = TextEditingController(
        text: widget.member.planFee.toStringAsFixed(0));
    expiryDate = widget.member.subscriptionEndDate;
    _selectedStaffId = widget.member.assignedStaffId?.isEmpty == true
        ? null
        : widget.member.assignedStaffId;
    _loadStaff();
  }

  Future<void> _loadStaff() async {
    try {
      final response = await ApiService().getStaff(limit: 100);
      if (mounted) setState(() => _staffList = response.staff);
    } catch (_) {}
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
      await ApiService().updateCustomer(
        customerId: widget.member.id,
        staffId: _selectedStaffId ?? "",
        name: nameController.text.trim(),
        phone: phoneController.text.trim(),
        email: emailController.text.trim(),
        subscriptionEndDate: expiryDate.toUtc().toIso8601String(),
        planFee: double.parse(feeController.text),
      );
      if (mounted) {
        AppUiHelper().showModernSnackBar(context, message: "Customer updated successfully");
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
        title: const Text('Edit Customer'),
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
                validator: (v) => AppUtils.validateName(v),
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
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.calendar_today, color: Colors.blue),
                title: const Text('Subscription End *'),
                subtitle: Text(expiryDate.toString().split(' ')[0]),
                onTap: () async {
                  final d = await showDatePicker(
                    context: context,
                    initialDate: expiryDate,
                    firstDate: DateTime.now().subtract(const Duration(days: 30)),
                    lastDate: DateTime.now().add(const Duration(days: 3650)),
                  );
                  if (d != null) setState(() => expiryDate = d);
                },
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<String?>(
                initialValue: _selectedStaffId,
                decoration: const InputDecoration(
                  labelText: 'Assigned Staff',
                  prefixIcon: Icon(Icons.person_pin),
                ),
                items: [
                  const DropdownMenuItem<String?>(
                    value: null,
                    child: Text('None (Unassigned)'),
                  ),
                  ..._staffList.map(
                    (s) => DropdownMenuItem<String?>(
                      value: s.id,
                      child: Text(s.name),
                    ),
                  ),
                ],
                onChanged: (val) => setState(() => _selectedStaffId = val),
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
                      : const Text('Save Changes'),
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