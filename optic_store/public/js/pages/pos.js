import pick from 'lodash/pick';
import keyBy from 'lodash/keyBy';

import { customer_qe_fields } from '../scripts/customer_qe';

const CUSTOMER_DETAILS_FIELDS = customer_qe_fields
  .filter(({ fieldtype }) => ['Data', 'Date', 'Small Text'].includes(fieldtype))
  .map(({ fieldname }) => fieldname);

function list2dict(key, list) {
  return Object.assign({}, ...list.map(item => ({ [item[key]]: item })));
}

function set_description(field) {
  return function(description) {
    field.set_new_description(description);
  };
}

function add_search_params_to_customer_mapper(customers_details = {}) {
  return function(item) {
    const { value, searchtext } = item;
    const customer = customers_details[value];
    if (searchtext && customer) {
      const searchtext_alt = ['os_crp_no', 'os_mobile_number'].reduce((a, param) => {
        const x = customer[param] && customer[param].toLowerCase();
        return x && !a.includes(x) ? `${a} ${x}` : a;
      }, searchtext);
      return Object.assign(item, { searchtext: searchtext_alt });
    }
    return item;
  };
}

export default function extend_pos(PosClass) {
  class PosClassExtended extends PosClass {
    async init_master_data(r) {
      super.init_master_data(r);
      try {
        const {
          message: {
            sales_persons = [],
            group_discounts = {},
            customers_details = [],
            loyalty_programs = [],
            gift_cards = [],
            territories = [],
            customer_groups = [],
          } = {},
        } = await frappe.call({
          method: 'optic_store.api.pos.get_extended_pos_data',
          args: { company: this.pos_profile_data.company },
          freeze: true,
          freeze_message: __('Syncing extended details'),
        });
        this.sales_persons_data = sales_persons.map(({ name, employee_name }) => ({
          label: employee_name,
          value: name,
        }));
        this.group_discounts_data = group_discounts;
        this.customers_details_data = list2dict('name', customers_details);
        this.customers_master_data = { territories, customer_groups };
        this.loyalty_programs_data = list2dict('name', loyalty_programs);
        this.gift_cards_data = list2dict('name', gift_cards);
        this.make_sales_person_field();
        this.make_group_discount_field();
      } catch (e) {
        console.warn(e);
        frappe.msgprint({
          indicator: 'orange',
          title: __('Warning'),
          message: __('Unable to load extended details. Usage will be restricted.'),
        });
      }
    }
    create_new() {
      super.create_new();
      if (this.sales_person_field) {
        this.sales_person_field.set_value('');
      }
    }
    make_control() {
      super.make_control();
      this.make_sales_person_field();
      this.make_group_discount_field();
    }
    toggle_totals_area(show) {
      super.toggle_totals_area(show);
      this.wrapper
        .find('.totals-area')
        .find('.group_discount-area')
        .toggle(!this.is_totals_area_collapsed);
      this.pos_bill.find('.discount-amount-area').hide();
    }
    prepare_customer_mapper(key) {
      const super_fn = super.prepare_customer_mapper;

      function extended_fn(key) {
        console.log('key: ', key);
        const starttime = Date.now();
        super_fn.bind(this)(key);
        console.log(`prepare_customer_mapper: ${(Date.now() - starttime) / 1000}s`);
        const customers_mapper_ext = key
          ? this.customers
              .filter(({ name }) => {
                const search = key.toLowerCase().trim();
                const reg = new RegExp(
                  search.replace(new RegExp('%', 'g'), '\\w*\\s*[a-zA-Z0-9]*')
                );
                const detail =
                  this.customers_details_data && this.customers_details_data[name];
                if (detail) {
                  return (
                    !this.customers_mapper.map(({ value }) => value).includes(name) &&
                    (reg.test(detail['os_crp_no']) ||
                      reg.test(detail['os_mobile_number']))
                  );
                }
                return false;
              })
              .map(({ name, customer_name, customer_group, territory }) => ({
                label: name,
                value: name,
                customer_name,
                customer_group,
                territory,
                searchtext: [name, customer_name, customer_group, territory]
                  .join(' ')
                  .toLowerCase(),
              }))
          : [];
        this.customers_mapper = [...this.customers_mapper, ...customers_mapper_ext].map(
          add_search_params_to_customer_mapper(this.customers_details_data)
        );
        this.party_field.awesomeplete.list = this.customers_mapper;
        console.log(`prepare_customer_mapper_ext: ${(Date.now() - starttime) / 1000}s`);
      }

      // required because this.party_field.$input event references this and
      // might run before super_fn executes and sets this.customers_mapper
      if (!this.customers_mapper) {
        this.customers_mapper = [];
      }

      if (this.os_timer_pcm) {
        window.cancelAnimationFrame(this.os_timer_pcm);
      }
      this.os_timer_pcm = window.requestAnimationFrame(extended_fn.bind(this, key));
    }
    update_customer(new_customer) {
      super.update_customer(new_customer);
      this.customer_doc.sections.forEach((section, i) => {
        if (i > 0) {
          section.wrapper.hide();
        }
      });
      this.customer_doc.add_fields([
        {
          fieldtype: 'Select',
          fieldname: 'territory',
          label: __('Territory'),
          default: this.pos_profile_data.territory,
          options: this.customers_master_data.territories,
        },
        { fieldtype: 'Column Break' },
        {
          fieldtype: 'Select',
          fieldname: 'customer_group',
          label: __('Customer Group'),
          default: this.pos_profile_data.customer_group,
          options: this.customers_master_data.customer_groups,
        },
      ]);
      this.customer_doc.add_fields(customer_qe_fields);
      this.customer_doc.set_values(
        pick(this.customers_details_data[this.frm.doc.customer] || {}, [
          ...CUSTOMER_DETAILS_FIELDS,
          'territory',
          'customer_group',
        ])
      );
    }
    get_prompt_details() {
      super.get_prompt_details();
      const { territory, customer_group } = this.customer_doc.get_values();
      this.prompt_details.territory = territory;
      this.prompt_details.customer_group = customer_group;
      return JSON.stringify(this.prompt_details);
    }
    make_item_list(customer) {
      super.make_item_list(customer);
      const items = keyBy(this.item_data, 'name');
      this.wrapper
        .find('.item-list')
        .find('.image-view-body')
        .children('a')
        .each((i, a) => {
          const { itemCode: item_code } = $(a).data();
          const {
            os_minimum_selling_rate: ms1 = 0,
            os_minimum_selling_2_rate: ms2 = 0,
          } = items[item_code] || {};
          if (ms1 || ms2) {
            $(
              `<span>
                <div>MS1: ${format_currency(ms1, this.frm.doc.currency)}</div>
                <div>MS2: ${format_currency(ms2, this.frm.doc.currency)}</div>
              </span>`
            )
              .css({
                position: 'absolute',
                left: '0',
                top: '0',
                padding: '5px 9px',
                'background-color': 'rgba(141, 153, 166, 0.6)',
                color: '#fff',
                'border-radius': '3px',
                'font-size': '0.75em',
              })
              .appendTo($(a).find('.image-field'));
          }
        });
    }
    validate() {
      if (!this.frm.doc.os_sales_person) {
        frappe.throw(__('Sales Person is mandatory'));
      }
      super.validate();
    }
    make_offline_customer(new_customer) {
      super.make_offline_customer(new_customer);
      const values = this.customer_doc.get_values();
      this.customers_details_data[this.frm.doc.customer] = Object.assign(
        {},
        this.customers_details_data[this.frm.doc.customer],
        pick(values, CUSTOMER_DETAILS_FIELDS)
      );
    }
    make_keyboard() {
      super.make_keyboard();
      this.add_more_payment_options();
    }
    update_payment_amount() {
      const { idx: gift_card_idx } =
        this.frm.doc.payments.find(
          ({ mode_of_payment }) => mode_of_payment === 'Gift Card'
        ) || {};
      if (cint(gift_card_idx) === cint(this.idx)) {
        if (this.payment_val > flt(this.os_payment_fg.get_value('gift_card_balance'))) {
          this.selected_mode.val(0);
          return frappe.throw(
            __('Payment with Gift Card cannot exceed available balance')
          );
        }
      }
      super.update_payment_amount();
    }
    submit_invoice() {
      if (this.frm.doc.grand_total !== this.frm.doc.paid_amount) {
        return frappe.throw(
          __(
            '<strong>Paid Amount</strong> must be equal to <strong>Total Amount</strong>'
          )
        );
      }
      const gift_card_no = this.os_payment_fg.get_value('gift_card_no');
      const { amount } = this.frm.doc.payments.find(
        ({ mode_of_payment }) => mode_of_payment === 'Gift Card'
      ) || { amount: 0 };
      const gift_card = this.gift_cards_data[gift_card_no];
      if (gift_card) {
        this.gift_cards_data[gift_card_no] = Object.assign(gift_card, {
          balance: flt(gift_card.balance) - amount,
        });
      }
      super.submit_invoice();
    }
    show_amounts() {
      super.show_amounts();
      this.dialog
        .get_primary_btn()
        .toggleClass('disabled', this.frm.doc.grand_total !== this.frm.doc.paid_amount);
    }

    make_sales_person_field() {
      if (!this.sales_person_field) {
        this.sales_person_field = new frappe.ui.form.ControlAutocomplete({
          parent: $('<div style="margin-top: 10px;" />').insertAfter(
            this.pos_bill.find('.totals-area')
          ),
          df: { options: this.sales_persons_data, label: __('Sales Person'), bold: 1 },
        });
        this.sales_person_field.refresh();
        this.sales_person_field.$input.on('change', () => {
          this.frm.doc.os_sales_person = this.sales_person_field.get_value();
        });
      } else {
        this.sales_person_field.set_data(this.sales_persons_data);
      }
    }
    make_group_discount_field() {
      if (this.pos_profile_data.allow_user_to_edit_discount) {
        const group_discounts = Object.keys(this.group_discounts_data || {});
        if (!this.group_discount_field) {
          const $parent = $(`
            <div class="pos-list-row group_discount-area" style="display: none;">
              <div class="cell text-right">${__('Group Discount')}</div>
              <div class="cell price-cell group_discount" style="padding-left: 24px;"/>
            </div>
            `)
            .insertAfter(this.pos_bill.find('.net-total-area'))
            .find('.group_discount');
          this.group_discount_field = new frappe.ui.form.ControlAutocomplete({
            parent: $parent,
            df: { options: group_discounts },
          });
          this.group_discount_field.toggle_label(false);
          this.group_discount_field.refresh();
          this.group_discount_field.$input.on('change', () => {
            const discounts_by_brand =
              this.group_discounts_data[this.group_discount_field.get_value()] || {};
            this.frm.doc.items.forEach(({ item_code, brand }) => {
              const discount_rate = discounts_by_brand[brand] || 0;
              this.update_discount(item_code, discount_rate);
            });
          });
        } else {
          this.group_discount_field.set_data(group_discounts);
        }
      }
    }
    make_payment() {
      if (this.dialog) {
        this.dialog.$wrapper.remove();
      }
      super.make_payment();
      ['.change_amount', '.write_off_amount'].forEach(q => {
        this.dialog.$body
          .find(q)
          .parent()
          .addClass('hidden');
      });
    }
    set_payment_primary_action() {
      // totally override validation to check for zero amount to enable payment thru
      // loyalty program
      this.dialog.set_primary_action(__('Submit'), () => {
        this.dialog.hide();
        this.submit_invoice();
      });
    }
    add_more_payment_options() {
      this.os_payment_fg = new frappe.ui.FieldGroup({
        parent: $('<div style="margin: 0 15px;" />').insertAfter(
          $(this.$body).find('.pos_payment .amount-row')
        ),
        fields: [
          {
            fieldtype: 'Section Break',
            label: __('Other Payments'),
            collapsible: 1,
          },
          {
            fieldtype: 'Column Break',
            label: __('Gift Card'),
          },
          {
            fieldname: 'gift_card_no',
            fieldtype: 'Data',
            label: __('Enter Gift Card No'),
          },
          {
            fieldname: 'gift_card_balance',
            fieldtype: 'Currency',
            label: __('Gift Card Balance'),
            read_only: 1,
            depends_on: 'gift_card_no',
          },
          {
            fieldtype: 'Column Break',
            label: __('Loyalty Program'),
          },
          {
            fieldname: 'loyalty_card_no',
            fieldtype: 'Data',
            label: __('Enter Loyalty Card No'),
          },
          {
            fieldname: 'loyalty_points_available',
            fieldtype: 'Int',
            label: __('Available Loyalty Points'),
            read_only: 1,
            depends_on: 'loyalty_card_no',
          },
          {
            fieldname: 'loyalty_points_redeem',
            fieldtype: 'Int',
            label: __('Points to Redeem'),
            depends_on: 'loyalty_card_no',
          },
          {
            fieldname: 'loyalty_amount_redeem',
            fieldtype: 'Currency',
            label: __('Amount to Redeem'),
            read_only: 1,
            depends_on: 'loyalty_card_no',
          },
        ],
      });
      this.os_payment_fg.make();

      const gift_card_field = this.os_payment_fg.get_field('gift_card_no');
      const set_gift_card_desc = set_description(gift_card_field);
      gift_card_field.$input.off('change');
      gift_card_field.$input.on('change', () => {
        const gift_card_no = gift_card_field.get_value();
        const details = this.gift_cards_data[gift_card_no];
        if (!details) {
          set_gift_card_desc(__('Unable to find Gift Card'));
        } else {
          const { name: gift_card, balance } = details;
          if (!balance) {
            set_gift_card_desc(__('Gift Card balance is depleted'));
          } else {
            set_gift_card_desc('');
            this.os_payment_fg.set_value('gift_card_balance', balance);
            this.frm.doc.os_gift_cards = [{ gift_card, balance }];
          }
        }
      });

      const loyalty_card_field = this.os_payment_fg.get_field('loyalty_card_no');
      const set_loyalty_card_desc = set_description(loyalty_card_field);
      loyalty_card_field.$input.off('change');
      loyalty_card_field.$input.on('change', () => {
        const loyalty_card_no = loyalty_card_field.get_value();
        const {
          os_loyalty_card_no: customer_card_no,
          loyalty_program: customer_loyalty_program,
          loyalty_points: customer_loyalty_points,
        } = this.customers_details_data[this.frm.doc.customer] || {};
        const { name: loyalty_program, conversion_rate } =
          this.loyalty_programs_data[customer_loyalty_program] || {};
        if (!loyalty_program) {
          set_loyalty_card_desc(__('Loyalty Program not found'));
        } else if (loyalty_program !== customer_loyalty_program) {
          set_loyalty_card_desc(__('Customer is not under this Loyalty Program'));
        } else if (loyalty_card_no !== customer_card_no) {
          set_loyalty_card_desc(
            __('The Loyalty Card does not belong to this Customer')
          );
        } else {
          set_loyalty_card_desc('');
          this.os_payment_fg.set_value(
            'loyalty_points_available',
            customer_loyalty_points
          );
        }
      });

      const loyalty_points_field = this.os_payment_fg.get_field(
        'loyalty_points_redeem'
      );
      loyalty_points_field.$input.off('change');
      loyalty_points_field.$input.on('change', () => {
        const loyalty_points = loyalty_points_field.get_value();
        const { loyalty_points: customer_loyalty_points = 0, loyalty_program } =
          this.customers_details_data[this.frm.doc.customer] || {};
        const { conversion_factor = 0 } =
          this.loyalty_programs_data[loyalty_program] || {};
        const { grand_total } = this.frm.doc;
        const allowed_amount = Math.min(
          flt(customer_loyalty_points) * conversion_factor,
          grand_total
        );
        const loyalty_amount =
          loyalty_points > allowed_amount ? 0 : flt(loyalty_points) * conversion_factor;
        this.os_payment_fg.set_value('loyalty_amount_redeem', loyalty_amount);
        if (loyalty_points > allowed_amount) {
          loyalty_points_field.$input.val(0);
          return frappe.throw(
            __(
              `Cannot redeem more than ${format_currency(
                allowed_amount,
                this.frm.doc.currency
              )}`
            )
          );
        }
        this.frm.doc = Object.assign(this.frm.doc, {
          redeem_loyalty_points: 1,
          os_loyalty_card_no: this.os_payment_fg.get_value('loyalty_card_no'),
          loyalty_program,
          loyalty_points,
          loyalty_amount,
        });
        this.selected_mode.val(grand_total - loyalty_amount);
        this.update_payment_amount();
      });
    }
  }
  return PosClassExtended;
}
