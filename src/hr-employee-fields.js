'use strict';

const employeeDetailFields = [
  { name: 'date_of_birth', label: 'Date of Birth', type: 'date', section: 'Personal details' },
  { name: 'gender', label: 'Gender', type: 'select', options: ['Male', 'Female', 'Other'] },
  { name: 'department', label: 'Department', master: true },
  { name: 'designation', label: 'Position', master: true },
  { name: 'phone', label: 'Telephone', type: 'tel', master: true },
  { name: 'email', label: 'Email', type: 'email', master: true },
  { name: 'nin', label: 'NIN' },
  { name: 'address', label: 'Address', type: 'textarea', rows: 3 },
  { name: 'marital_status', label: 'Marital Status', type: 'select', options: ['Single', 'Married', 'Divorced', 'Separated', 'Widowed'] },
  { name: 'nationality', label: 'Nationality' },
  { name: 'next_of_kin', label: 'Next of Kin', section: 'Family and emergency contacts' },
  { name: 'next_of_kin_phone', label: 'Next of Kin Telephone', type: 'tel' },
  { name: 'next_of_kin_relation', label: 'Next of Kin Relation' },
  { name: 'father', label: 'Father' },
  { name: 'father_phone', label: 'Father Telephone', type: 'tel' },
  { name: 'mother', label: 'Mother' },
  { name: 'mother_phone', label: 'Mother Telephone', type: 'tel' },
  { name: 'education', label: 'Education', type: 'textarea', rows: 6, section: 'Education and work history', maxlength: 10000 },
  { name: 'work_experience', label: 'Work Experience', type: 'textarea', rows: 6, maxlength: 10000 },
  { name: 'references', label: 'References', type: 'textarea', rows: 3, section: 'References', hint: 'For each reference, list Name, Entity, Position, and Telephone number. Enter each reference on a separate line.' },
];

module.exports = { employeeDetailFields };
