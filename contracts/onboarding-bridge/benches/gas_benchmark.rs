#![cfg(feature = "testutils")]

use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::Address as _,
    Address, Env, IntoVal, Vec,
};

use onboarding_bridge::OnboardingBridge;

#[contracttype]
pub enum TDataKey {
    Admin,
    Decimal,
    Name,
    Symbol,
    Initialized,
    Balance,
}

#[contract]
pub struct BenchToken;

#[contractimpl]
impl BenchToken {
    pub fn initialize(
        e: Env,
        admin: Address,
        decimal: u32,
        name: soroban_sdk::String,
        symbol: soroban_sdk::String,
    ) {
        e.storage().instance().set(&TDataKey::Admin, &admin);
        e.storage().instance().set(&TDataKey::Decimal, &decimal);
        e.storage().instance().set(&TDataKey::Name, &name);
        e.storage().instance().set(&TDataKey::Symbol, &symbol);
        e.storage().instance().set(&TDataKey::Initialized, &true);
    }

    pub fn mint(e: Env, to: Address, amount: i128) {
        let admin: Address = e.storage().instance().get(&TDataKey::Admin).unwrap();
        admin.require_auth();
        let bal = Self::balance(e.clone(), to.clone());
        e.storage()
            .persistent()
            .set(&(TDataKey::Balance, to), &(bal + amount));
    }

    pub fn balance(e: Env, id: Address) -> i128 {
        e.storage()
            .persistent()
            .get(&(TDataKey::Balance, id))
            .unwrap_or(0)
    }

    pub fn transfer(e: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let from_bal = Self::balance(e.clone(), from.clone());
        if from_bal < amount {
            panic!("insufficient balance");
        }
        let to_bal = Self::balance(e.clone(), to.clone());
        e.storage()
            .persistent()
            .set(&(TDataKey::Balance, from), &(from_bal - amount));
        e.storage()
            .persistent()
            .set(&(TDataKey::Balance, to), &(to_bal + amount));
    }
}

struct BenchResult {
    function_name: &'static str,
    variant: &'static str,
    cpu_insns: u64,
    mem_bytes: u64,
}

fn setup_env() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let bridge_id = env.register(OnboardingBridge, ());
    let token_id = env.register(BenchToken, ());

    let admin = Address::generate(&env);
    let fee_collector = Address::generate(&env);

    let token = BenchTokenClient::new(&env, &token_id);
    token.initialize(
        &admin,
        &7u32,
        &"Bench".into_val(&env),
        &"BCH".into_val(&env),
    );

    (env, bridge_id, token_id, admin, fee_collector)
}

fn bench_initialize() -> BenchResult {
    let (env, bridge_id, _token_id, admin, fee_collector) = setup_env();
    let bridge = onboarding_bridge::OnboardingBridgeClient::new(&env, &bridge_id);

    env.budget().reset_default();
    env.budget().reset_tracker();

    bridge.initialize(&admin, &fee_collector, &100u32, &None);

    let cpu = env.budget().cpu_instruction_cost();
    let mem = env.budget().memory_bytes_cost();

    BenchResult {
        function_name: "initialize",
        variant: "first_time",
        cpu_insns: cpu,
        mem_bytes: mem,
    }
}

fn bench_fund_c_address(amount: i128, variant: &'static str) -> BenchResult {
    let (env, bridge_id, token_id, admin, fee_collector) = setup_env();
    let bridge = onboarding_bridge::OnboardingBridgeClient::new(&env, &bridge_id);
    let token = BenchTokenClient::new(&env, &token_id);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);

    let user = Address::generate(&env);
    token.mint(&user, &(amount * 2));
    let target = Address::generate(&env);

    env.budget().reset_default();
    env.budget().reset_tracker();

    bridge.fund_c_address(&user, &target, &token_id, &amount, &None, &None);

    let cpu = env.budget().cpu_instruction_cost();
    let mem = env.budget().memory_bytes_cost();

    BenchResult {
        function_name: "fund_c_address",
        variant,
        cpu_insns: cpu,
        mem_bytes: mem,
    }
}

fn bench_batch_fund(batch_size: u32) -> BenchResult {
    let (env, bridge_id, token_id, admin, fee_collector) = setup_env();
    let bridge = onboarding_bridge::OnboardingBridgeClient::new(&env, &bridge_id);
    let token = BenchTokenClient::new(&env, &token_id);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);

    let user = Address::generate(&env);
    token.mint(&user, &(1000i128 * batch_size as i128 * 2));

    let mut targets = Vec::new(&env);
    let mut amounts = Vec::new(&env);
    for _ in 0..batch_size {
        targets.push_back(Address::generate(&env));
        amounts.push_back(1000i128);
    }

    env.budget().reset_default();
    env.budget().reset_tracker();

    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None);

    let cpu = env.budget().cpu_instruction_cost();
    let mem = env.budget().memory_bytes_cost();

    let variant_str = match batch_size {
        1 => "batch_1",
        5 => "batch_5",
        10 => "batch_10",
        50 => "batch_50",
        _ => "batch_other",
    };

    BenchResult {
        function_name: "batch_fund_c_address",
        variant: variant_str,
        cpu_insns: cpu,
        mem_bytes: mem,
    }
}

fn bench_set_fee_bps() -> BenchResult {
    let (env, bridge_id, _token_id, admin, fee_collector) = setup_env();
    let bridge = onboarding_bridge::OnboardingBridgeClient::new(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);

    env.budget().reset_default();
    env.budget().reset_tracker();

    bridge.set_fee_bps(&200u32, &None);

    let cpu = env.budget().cpu_instruction_cost();
    let mem = env.budget().memory_bytes_cost();

    BenchResult {
        function_name: "set_fee_bps",
        variant: "default",
        cpu_insns: cpu,
        mem_bytes: mem,
    }
}

fn bench_withdraw_fees() -> BenchResult {
    let (env, bridge_id, token_id, admin, fee_collector) = setup_env();
    let bridge = onboarding_bridge::OnboardingBridgeClient::new(&env, &bridge_id);
    let token = BenchTokenClient::new(&env, &token_id);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);

    let user = Address::generate(&env);
    token.mint(&user, &10_000i128);
    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &5000i128, &None, &None);

    env.budget().reset_default();
    env.budget().reset_tracker();

    bridge.withdraw_fees(&token_id, &50i128, &None);

    let cpu = env.budget().cpu_instruction_cost();
    let mem = env.budget().memory_bytes_cost();

    BenchResult {
        function_name: "withdraw_fees",
        variant: "default",
        cpu_insns: cpu,
        mem_bytes: mem,
    }
}

fn bench_query_fee_bps() -> BenchResult {
    let (env, bridge_id, _token_id, admin, fee_collector) = setup_env();
    let bridge = onboarding_bridge::OnboardingBridgeClient::new(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);

    env.budget().reset_default();
    env.budget().reset_tracker();

    bridge.query_fee_bps();

    let cpu = env.budget().cpu_instruction_cost();
    let mem = env.budget().memory_bytes_cost();

    BenchResult {
        function_name: "query_fee_bps",
        variant: "default",
        cpu_insns: cpu,
        mem_bytes: mem,
    }
}

fn bench_query_balance() -> BenchResult {
    let (env, bridge_id, token_id, admin, fee_collector) = setup_env();
    let bridge = onboarding_bridge::OnboardingBridgeClient::new(&env, &bridge_id);
    let token = BenchTokenClient::new(&env, &token_id);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);

    let user = Address::generate(&env);
    token.mint(&user, &1000i128);

    env.budget().reset_default();
    env.budget().reset_tracker();

    bridge.query_balance(&user, &token_id);

    let cpu = env.budget().cpu_instruction_cost();
    let mem = env.budget().memory_bytes_cost();

    BenchResult {
        function_name: "query_balance",
        variant: "default",
        cpu_insns: cpu,
        mem_bytes: mem,
    }
}

fn bench_query_total_bridged() -> BenchResult {
    let (env, bridge_id, token_id, admin, fee_collector) = setup_env();
    let bridge = onboarding_bridge::OnboardingBridgeClient::new(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);

    env.budget().reset_default();
    env.budget().reset_tracker();

    bridge.query_total_bridged(&token_id);

    let cpu = env.budget().cpu_instruction_cost();
    let mem = env.budget().memory_bytes_cost();

    BenchResult {
        function_name: "query_total_bridged",
        variant: "default",
        cpu_insns: cpu,
        mem_bytes: mem,
    }
}

fn main() {
    let results = vec![
        bench_initialize(),
        bench_fund_c_address(100, "minimum"),
        bench_fund_c_address(5_000, "average"),
        bench_fund_c_address(1_000_000, "maximum"),
        bench_batch_fund(1),
        bench_batch_fund(5),
        bench_batch_fund(10),
        bench_batch_fund(50),
        bench_set_fee_bps(),
        bench_withdraw_fees(),
        bench_query_fee_bps(),
        bench_query_balance(),
        bench_query_total_bridged(),
    ];

    println!("{{");
    println!("  \"benchmark_results\": [");
    for (i, r) in results.iter().enumerate() {
        let comma = if i < results.len() - 1 { "," } else { "" };
        println!(
            "    {{ \"function\": \"{}\", \"variant\": \"{}\", \"cpu_insns\": {}, \"mem_bytes\": {} }}{}",
            r.function_name, r.variant, r.cpu_insns, r.mem_bytes, comma
        );
    }
    println!("  ]");
    println!("}}");
}

#[cfg(test)]
mod bench_tests {
    use super::*;

    #[test]
    fn run_all_benchmarks() {
        let results = vec![
            bench_initialize(),
            bench_fund_c_address(100, "minimum"),
            bench_fund_c_address(5_000, "average"),
            bench_fund_c_address(1_000_000, "maximum"),
            bench_batch_fund(1),
            bench_batch_fund(5),
            bench_batch_fund(10),
            bench_batch_fund(50),
            bench_set_fee_bps(),
            bench_withdraw_fees(),
            bench_query_fee_bps(),
            bench_query_balance(),
            bench_query_total_bridged(),
        ];

        for r in &results {
            assert!(r.cpu_insns > 0, "{}/{} should use CPU", r.function_name, r.variant);
            assert!(r.mem_bytes > 0, "{}/{} should use memory", r.function_name, r.variant);
        }
    }
}
